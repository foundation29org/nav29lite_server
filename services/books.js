'use strict'
const config = require('./../config')
const crypt = require('../services/crypt')
const axios = require('axios');
const langchain = require('../services/langchain')
const suggestions = require('../services/suggestions')
const pubsub = require('../services/pubsub');
const insights = require('../services/insights')
const countTokens = require( '@anthropic-ai/tokenizer');

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
const Patient = require('../models/patient')


async function callNavigator(req, res) {
	var result = await langchain.navigator_summarize(req.body.userId, req.body.question, req.body.conversation, req.body.context);
	res.status(200).send(result);
}

async function callSummary(req, res) {
	let promt = `Please extract a rich set of information from the following medical document.
	Everything that could be useful for an expert doctor to understand the patient's situation.
	But also every that could be useful for the patient to understand his situation. And to be able to ask questions about it.
	The goal of this is to store the information in a clean way so that it can be used for further analysis in the future.  
	Starting with an overview of the document type and its purpose, (Always start with: The document you just uploaded is a [document type] and its purpose is to [purpose])
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
	createBook,
	anonymizeBooks,
	deleteBook,
	extractEvents,
	anonymizeDocument,
	analizeDoc
}
