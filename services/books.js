'use strict'
const config = require('./../config')
const crypt = require('../services/crypt')
const axios = require('axios');
const langchain = require('../services/langchain')
const suggestions = require('../services/suggestions')
const pubsub = require('../services/pubsub');
const insights = require('../services/insights')
const countTokens = require( '@anthropic-ai/tokenizer');
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer"); 
const {
	SearchClient,
	SearchIndexClient,
	AzureKeyCredential,
	odata,
  } = require("@azure/search-documents");  
const sas = config.BLOB.SAS;
const endpoint = config.SEARCH_API_ENDPOINT;
const apiKey = config.SEARCH_API_KEY;
const accountname = config.BLOB.NAMEBLOB;
const Document = require('../models/document')
const Patient = require('../models/patient');
const { response } = require('express');
const form_recognizer_key = config.FORM_RECOGNIZER_KEY
const form_recognizer_endpoint = config.FORM_RECOGNIZER_ENDPOINT
const levenshtein = require('js-levenshtein');


async function callNavigator(req, res) {
	var result = await langchain.navigator_summarize(req.body.userId, req.body.question, req.body.conversation, req.body.context);
	res.status(200).send(result);
}

async function callSummary(req, res) {
	let promt = `Please extract a rich set of information from the patient medical documents.
	Everything that could be useful for an expert doctor to understand the patient's situation.
	But also every that could be useful for the patient to understand his situation. And to be able to ask questions about it.
	The goal of this is to store the information in a clean way so that it can be used for further analysis in the future.  
	Starting with an overview of the documents type and its purposes, (Always start with: The documents you just uploaded are a [document type] and its purposes are to [purpose])
	then continue with an introduction of the patient,
	then extract all the medical information and sort it into all the possible general categories (e.g. diagnosis, treatment, medication, etc.),
	then if necessary, add non-medical information but relevant into the "Other" category.`;
	var result = await langchain.navigator_summarize(req.body.userId,promt, req.body.conversation, req.body.context);
	res.status(200).send(result);
}

async function analizeDoc(req, res) {
	res.status(200).send({message: 'ok'})
	const containerName = req.body.containerName;
	const url = req.body.url;
	const documentId = req.body.documentId;
	const filename = req.body.filename;
	const patientId = req.body.patientId;
	const userId = req.body.userId;
	// si algún parametro no existe no se hace nada
	//track this
	if (!containerName || !url || !documentId || !filename || !patientId) {
		return;
	}
	// Call the langchain function to summarize the document
	langchain.summarize(patientId, containerName, url, documentId, filename, userId);
	langchain.clean_and_extract(patientId, containerName, url, documentId, filename, userId);
	// Call the Azure function to create the extraction questions
	// extractEvents(patientId, documentId, containerName, url, filename, userId);
	// Call the langchain function to anonymize the document
	let isDonating = await isDonatingData(patientId);
	if (isDonating) {
		setStateAnonymizedDoc(documentId, 'inProcess')
		let anonymized = await langchain.anonymize(patientId, containerName, url, documentId, filename, userId);
		if (anonymized) {
			setStateAnonymizedDoc(documentId, 'true')
		} else {
			setStateAnonymizedDoc(documentId, 'false')
		}
	}		
}

function convertTableToMarkdown(table) {
	let markdownTable = "|";
	
	// Add column headers
	for (let col = 0; col < table.columnCount; col++) {
	  markdownTable += ` ${table.cells[col].content} |`;
	}
	markdownTable += "\n|";
	
	// Add separator
	for (let col = 0; col < table.columnCount; col++) {
	  markdownTable += "------|";
	}
	markdownTable += "\n";
	
	// Add table rows
	for (let row = 1; row < table.rowCount; row++) {
	  markdownTable += "|";
	  for (let col = 0; col < table.columnCount; col++) {
		let cell = table.cells.find(c => c.rowIndex === row && c.columnIndex === col);
		markdownTable += ` ${cell ? cell.content : " "} |`;
	  }
	  markdownTable += "\n";
	}
	return markdownTable;
}

function findTableKeywords(table, numWordsToConsider = 8) {
    let startKeywords = [];
    let endKeywords = [];

    const getCellContent = (row, col) => {
        let cell = table.cells.find(c => c.rowIndex === row && c.columnIndex === col);
        return cell ? cell.content.trim() : "";
    };

    // Gather starting keywords
    for (let row = 0; row < table.rowCount && startKeywords.length < numWordsToConsider; row++) {
        for (let col = 0; col < table.columnCount && startKeywords.length < numWordsToConsider; col++) {
            let content = getCellContent(row, col);
            if (content) startKeywords.push(content);
        }
    }

    // Gather ending keywords
    let lastRow = table.rowCount - 1;
    while (endKeywords.length < numWordsToConsider && lastRow >= 0) {
        for (let col = table.columnCount - 1; col >= 0 && endKeywords.length < numWordsToConsider; col--) {
            let content = getCellContent(lastRow, col);
            if (content) endKeywords.unshift(content);
        }
        lastRow--;
    }

    return {
        start: startKeywords.join(" "),
        end: endKeywords.join(" ")
    };
}


function normalizeText(text) {
	return text.replace(/\n/g, " ").replace(/\s+/g, " ").toLowerCase();
  }

function findApproximateIndex(content, keyword, threshold) {
    for (let i = 0; i < content.length - keyword.length + 1; i++) {
        let substring = content.slice(i, i + keyword.length);
        if (levenshtein(substring, keyword) <= threshold) {
            return i;
        }
    }
    return -1;
}

async function form_recognizer(documentId, containerName, url) {
	return new Promise(async function (resolve, reject) {
	var url2 = "https://" + accountname + ".blob.core.windows.net/" + containerName + "/" + url + sas;
	const client = new DocumentAnalysisClient(form_recognizer_endpoint, new AzureKeyCredential(form_recognizer_key));

	const poller = await client.beginAnalyzeDocument("prebuilt-layout", url2);

	let {
		content,
		pages,
		tables,
	} = await poller.pollUntilDone();
	
	let markdownTables = tables.map(table => convertTableToMarkdown(table));
	// console.log("Converted tables to Markdown:", markdownTables);

	let newContent = "";  // Initialize a string to accumulate the changes
	let lastEndIndex = 0;  // Keep track of where the last table ended
	let failedTables = 0;  // Initialize a counter for failed tables

	// console.log(normalizeText(content))

	// 2. Localize tables in "content" and store table indices in a dictionary for potential second search
	let tableIndices = {};
	markdownTables.forEach((markdownTable, index) => {
		console.log(`Processing table ${index + 1}...`);
		let tableKeywords = findTableKeywords(tables[index]);  // Assuming you have a function findTableKeywords
		// console.log("Identified table keywords:", tableKeywords);
		
		let normalizedContent = normalizeText(content);
		let normalizedStart = normalizeText(tableKeywords.start);
		let normalizedEnd = normalizeText(tableKeywords.end);

		// console.log(`Normalized table keywords start: ${normalizedStart}`);
		// console.log(`Normalized table keywords end: ${normalizedEnd}`);

		// Search for normalized indices
		let tableStart = normalizedContent.indexOf(normalizedStart, lastEndIndex);
		let tableEnd = normalizedContent.indexOf(normalizedEnd, tableStart);
		// If found, update lastEndIndex and store the indices
		if (tableStart !== -1 && tableEnd !== -1) {
				// Update lastEndIndex to point to the end of the replaced segment in the original content
    			lastEndIndex = tableEnd + normalizedEnd.length;
                console.log("Table found successfully!");
            } else {
                console.log("Table not found in content. Skipping...");
                failedTables++;  // Increment the counter for failed tables
            }
		// Store the indices of the tables for a potential second search and the LastEndIndex for narrowing the search
		tableIndices[index] = {start: tableStart, end: tableEnd, lastEndIndex: lastEndIndex};
	});

	// 3. Perform a second search for tables that were not found in the first pass only if failedTables > 0
	if (failedTables > 0) {
		console.log("Performing second search for missing tables...");
		markdownTables.forEach((markdownTable, index) => {
			let {start: tableStart, end: tableEnd, lastEndIndex} = tableIndices[index];
			let normalizedContent = normalizeText(content);

			// Check if either tableStart or tableEnd is missing
			if (tableStart === -1 || tableEnd === -1) {
				console.log(`Attempting second search for table ${index + 1}...`);

				// Determine the search space for the next table
				let nextTableStart = index < markdownTables.length - 1 ? tableIndices[index + 1].start : normalizedContent.length;

				let normalizedStart = normalizeText(findTableKeywords(tables[index]).start);
				let normalizedEnd = normalizeText(findTableKeywords(tables[index]).end);

				// If only tableStart is found
				if (tableStart !== -1 && tableEnd === -1) {
					console.log("Using narrowed search for tableEnd...");
					let threshold = Math.round(normalizedEnd.length * 0.3);  // Allowing 30% difference
					tableEnd = findApproximateIndex(normalizedContent.slice(tableStart, nextTableStart), normalizedEnd, threshold) + tableStart;
				}

				// If only tableEnd is found
				if (tableStart === -1 && tableEnd !== -1) {
					console.log("Using narrowed search for tableStart...");
					let threshold = Math.round(normalizedStart.length * 0.3);  // Allowing 30% difference
					tableStart = findApproximateIndex(normalizedContent.slice(lastEndIndex, tableEnd), normalizedStart, threshold) + lastEndIndex;
				}

				// If neither is found, perform a narrowed search
				if (tableStart === -1 && tableEnd === -1) {
					console.log("Using narrowed search for both tableStart and tableEnd...");
					let threshold = Math.round(normalizedStart.length * 0.3);  // Allowing 30% difference
					tableStart = findApproximateIndex(normalizedContent.slice(lastEndIndex, nextTableStart), normalizedStart, threshold) + lastEndIndex;
					threshold = Math.round(normalizedEnd.length * 0.3);  // Allowing 30% difference
					tableEnd = findApproximateIndex(normalizedContent.slice(tableStart, nextTableStart), normalizedEnd, threshold) + tableStart;
				}

				// If found in the second search, decrement the counter for failed tables and save the indices
				if (tableStart !== -1 && tableEnd !== -1) {
					console.log("Table found in second search!: ", tableStart, tableEnd);
					failedTables--;  // Decrement the counter for failed tables
				} else {
					console.log("Table still not found in second search. Skipping...");
				}
				// Update tableIndices
				tableIndices[index].start = tableStart;
				tableIndices[index].end = tableEnd;
				tableIndices[index].lastEndIndex = tableEnd + normalizedEnd.length;
			}
		});
	}
	// Now with all the tables found, we can replace them in the original content
	markdownTables.forEach((markdownTable, index) => {
		let {start: tableStart, end: tableEnd} = tableIndices[index];
		let lastEndIndex = index === 0 ? 0 : tableIndices[index - 1].lastEndIndex;
		console.log(`Replacing table ${index + 1}...`);
		console.log(`Table start index: ${tableStart}, Table end index: ${tableEnd}, Last end index: ${lastEndIndex}`);
		// If table is found, replace it in newContent
		if (tableStart !== -1 && tableEnd !== -1) {
			// Append content up to the current table
			newContent += content.slice(lastEndIndex, tableStart);
			// Insert the Markdown table
			let insertedString = "\n\n<!-- START TABLE -->\n<div class='markdown-table'>\n" + markdownTable + "\n</div>\n<!-- END TABLE -->\n\n";
			newContent += insertedString;
		}
	});

	// Append the remaining content to newContent
	newContent += content.slice(lastEndIndex);
	// Log the number of failed tables
	console.log(`Number of failed tables: ${failedTables}`);
	// 3. Actualizar el contenido del documento
	content = newContent;
	
	var response = {
	"msg": "done", 
	"data": content, 
	"doc_id": documentId, 
	"status": 200
	}

	const tokens = countTokens.countTokens(response.data);
	response.tokens = tokens;
	resolve(response);
	});
  }

async function createBook(documentId, containerName, url, filename) {
	return new Promise(async function (resolve, reject) {
		var url2 = "https://" + accountname + ".blob.core.windows.net/" + containerName + "/" + url + sas;
		const configcall = {
			params: {
				doc_id: documentId,
				url: url2,
				urlanalizeDoc: url,
				filename: filename,
				containerName: containerName
			}
		};
		axios.post(config.KUBERNETEURL + '/triggerExtractLite', null, configcall)
			.then(async response => {
				const tokens = countTokens.countTokens(response.data.data);
				response.data.tokens = tokens;
				resolve(response.data);
			})
			.catch(error => {
				insights.error(error);
				console.error(error);
				var respu = {
					"msg": error,
					"status": 500
				}
				resolve(respu);
			});
		});
}

async function extractEvents(patientId, documentId, containerName, url, filename, userId) {
	return new Promise(async function (resolve, reject) {
		var url2 = "https://" + accountname + ".blob.core.windows.net/" + containerName + "/" + url + sas;
		const configcall = {
			params: {
				index: patientId,
				doc_id: documentId,
				url: url2,
				filename: filename,
				userId: userId,
			}
		};
		axios.post(config.AF29URL + '/api/HttpTriggerCreateCustomBook', null, configcall)
			.then(response => {
				try {
					// const jsonObject = JSON.parse(response.data.table);
					resolve(response.data);
				} catch (error) {
					insights.error(error);
					var respu = {
						"msg": error,
						"status": 500
					}
					resolve(respu);
				}

			})
			.catch(error => {
				pubsub.sendToUser(userId, { "docId": documentId, "status": "error extractEvents", "filename": filename, "error": error })
				insights.error(error);
				console.error(error);
				var respu = {
					"msg": error,
					"status": 500
				}
				resolve(respu);
			});
	});
}

async function isDonatingData(patientId) {
	return new Promise(async function (resolve, reject) {
		Patient.findById(patientId, { "_id": false, "createdBy": false }, (err, patient) => {
			if (err) resolve(false)
			if (patient) {
				if (patient.donation) {
					resolve(true);
				} else {
					resolve(false);
				}
			} else {
				resolve(false);
			}

		})
	});
}

async function anonymizeBooks(documents) {
	return new Promise(async function (resolve, reject) {
		const promises = [];
		for (let i = 0; i < documents.length; i++) {
			let document = documents[i];
			promises.push(anonymizeDocument(document));
		}
		Promise.all(promises)
			.then((data) => {
				resolve(data);
			})
			.catch((err) => {
				insights.error(err);
				respu.message = err;
				resolve(respu);
			});
	});

}

async function anonymizeDocument(document) {
	return new Promise(async function (resolve, reject) {
		if (document.anonymized == 'false') {
			let userId = await getUserId(document.createdBy);
			if (userId != null) {
				userId = crypt.encrypt(userId.toString());
				let patientId = document.createdBy.toString();
				let idencrypt = crypt.encrypt(patientId);
				let containerName = (idencrypt).substr(1);
				let filename = document.url.split("/").pop();
				setStateAnonymizedDoc(document._id, 'inProcess')
				let docId = document._id.toString();
				let anonymized = await langchain.anonymize(patientId, containerName, document.url, docId, filename, userId);
				if (anonymized) {
					setStateAnonymizedDoc(document._id, 'true')
				} else {
					setStateAnonymizedDoc(document._id, 'false')
				}
				resolve(true);
			}
		}else{
			resolve(true);
		}
	});

}

function setStateAnonymizedDoc(documentId, state) {
	console.log(documentId)
	Document.findByIdAndUpdate(documentId, { anonymized: state }, { new: true }, (err, documentUpdated) => {
		if (err){
			insights.error(err);
			console.log(err)
		}
		if (!documentUpdated){
			insights.error('Error updating document');
			console.log('Error updating document')
		}
	})
}

async function getUserId(patientId) {
	return new Promise(async function (resolve, reject) {
		Patient.findById(patientId, { "_id": false }, (err, patient) => {
			if (err){
				insights.error(err);
				console.log(err)
				resolve(null)
			} 
			if (patient) {
				resolve(patient.createdBy);
			} else {
				insights.error('No patient found');
				console.log('No patient found')
				resolve(null)
			}
		})
	});
}

async function deleteBook(patientId, documentId) {
	return new Promise(async function (resolve, reject) {
		Document.find({ "createdBy": patientId }, { "createdBy": false }, async (err, eventsdb) => {
			if (err){
				insights.error(err);
				return res.status(500).send({ message: `Error making the request: ${err}` })
			} 
			if (!eventsdb) {
				try {
					await deleteIndexAzure(patientId)
					await deleteIndexAzure('convmemory'+patientId)
					resolve(true);
				} catch (error) {
					insights.error(error);
					resolve(false);
				}

			} else {
				if (eventsdb.length == 1) {
					try {
						await deleteIndexAzure(patientId)
						await deleteIndexAzure('convmemory'+patientId)
						resolve(true);
					} catch (error) {
						insights.error(error);
						resolve(false);
					}

				} else {
					try {
						await deleteDocumentAzure(patientId, documentId)
						resolve(true);
					} catch (error) {
						insights.error(error);
						resolve(false);
					}
				}

			}
		});

	});
}

async function deleteIndexAzure(indexName){
    return new Promise(async function (resolve, reject) {
        const searchClient = new SearchIndexClient(endpoint, new AzureKeyCredential(apiKey));
        const indexResult = await searchClient.listIndexes();
        let currentIndex = await indexResult.next();
        
        while (!currentIndex.done) {
            if (currentIndex.value.name === String(indexName)) {
                try {
                    await searchClient.deleteIndex(String(indexName));
                    resolve(true);
                    return;
                } catch (error) {
					console.log(`Error deleting index ${indexName}:`, error);
                    reject(error);
                    return;
                }
            }
            currentIndex = await indexResult.next();
        }

        console.log(`El índice ${indexName} no existe.`);
        resolve(false);
    });
}

async function deleteDocumentAzure(patientId, documentId){
	// To query and manipulate documents
	const indexClient = new SearchClient(endpoint, String(patientId), new AzureKeyCredential(apiKey),);
	// Define the search options
	const searchResult = await indexClient.search("*", {
		filter: `doc_id eq '${documentId}'`,
	});
	// Get all the ids of the documents to batch delete them
	let documentIdsToDelete = [];
	for await (const result of searchResult.results) {
		documentIdsToDelete.push(result.document.id);
	  }
	// Batch delete the documents
	const deleteResult = await indexClient.deleteDocuments("id", documentIdsToDelete);
}


module.exports = {
	callNavigator,
	callSummary,
	form_recognizer,
	createBook,
	anonymizeBooks,
	deleteBook,
	extractEvents,
	anonymizeDocument,
	analizeDoc
}
