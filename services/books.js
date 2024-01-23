'use strict'
const config = require('./../config')
const crypt = require('../services/crypt')
const axios = require('axios');
const langchain = require('../services/langchain')
const suggestions = require('../services/suggestions')
const f29azureService = require("../services/f29azure")
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
const Patient = require('../models/patient');
const form_recognizer_key = config.FORM_RECOGNIZER_KEY
const form_recognizer_endpoint = config.FORM_RECOGNIZER_ENDPOINT



async function callNavigator(req, res) {
	var result = await langchain.navigator_chat(req.body.userId, req.body.question, req.body.conversation, req.body.context);
	res.status(200).send(result);
}

async function callSummary(req, res) {
	let prompt = '';
	if(req.body.role=='physician'){
		prompt = `Please provide a comprehensive and detailed summary of the patient's medical documents. 
		Include all relevant clinical data, diagnoses, treatment plans, and medications, ensuring the information is precise and thorough for expert medical analysis. 
		The summary should facilitate a deep understanding of the patient's medical situation, suitable for a healthcare professional. 
		Start with an overview of the document type and its purposes (Always start with: "The documents you just uploaded are a [document type] and its purposes are to [purpose]"), 
		followed by the patient introduction, medical details categorized into sections like diagnosis, treatment, medication, etc., 
		and include any pertinent non-medical information in the "Other" category.`;
		
	}else if(req.body.role=='young'){
		prompt = `Please create a simple and engaging summary of the patient's medical documents, tailored for a young audience. 
		Use clear and straightforward language to explain the patient's medical situation, including any diagnoses and treatments. 
		The summary should be informative yet easy to understand, enabling a pediatric patient to grasp their health status and ask questions. 
		Begin with a basic explanation of the document type and its purpose (Always start with: "The documents you just uploaded are a [document type] and they are important because [purpose]"), 
		followed by a friendly introduction of the patient, a simplified breakdown of medical information into categories like diagnosis and treatment, 
		and any other relevant information in an easy-to-understand "Other" category.`;
		
	}else if(req.body.role=='adult'){
		prompt = `Please generate a clear and concise summary of the patient's medical documents, suitable for an adult audience. 
		The summary should include essential information about diagnoses, treatments, and medications, presented in a way that is easy to understand for a non-expert. 
		Aim to empower the patient with knowledge about their medical situation to facilitate informed discussions with healthcare providers. 
		Start with a brief overview of the document type and its purpose (Always start with: "The documents you just uploaded are a [document type] and they help to explain [purpose]"), 
		followed by an introduction of the patient, a well-organized presentation of medical data in categories like diagnosis, treatment, medication, etc., 
		and include any relevant additional information in the "Other" category.`;
		
	}

	let prompt2 = `Please create a JSON timeline from the patient's medical documents and events, with keys for 'date' and 'key_medical_event'.
	 Extract main medical events from the documents and events, and add them to the timeline.
	 The timeline should be structured as a list of events, with each event containing a date and an small description of the event.
	`

	// var result = await langchain.navigator_summarize(req.body.userId, promt, req.body.conversation, req.body.context);
	let timeline = true;
	let promises = [
		azureFuncSummary(req, prompt),
		azureFuncSummary(req, prompt2, timeline)
	];
	
	// Utilizar Promise.all para esperar a que todas las promesas se resuelvan
	let [result, result2] = await Promise.all(promises);

	if(result.data){
		let data = {
			nameFiles: req.body.nameFiles,
			promt: prompt,
			role: req.body.role,
			conversation: req.body.conversation,
			context: req.body.context,
			result: result.data
		}
		let nameurl = req.body.paramForm+'/summary.json';
		f29azureService.createBlobSimple('data', nameurl, data);
	}

	if(result2.data){
		let data = {
			nameFiles: req.body.nameFiles,
			promt: prompt2,
			role: req.body.role,
			conversation: req.body.conversation,
			context: req.body.context,
			result: result2.data
		}
		let nameurl = req.body.paramForm+'/timeline.json';
		f29azureService.createBlobSimple('data', nameurl, data);
	}

	let finalResult = {
		"msg": "done", 
		"result1": result.data,
		"result2": result2.data,
		"status": 200
		}

	res.status(200).send(finalResult);
	}
// 	)
// 		.catch(error => {
// 			console.error(error);
// 			res.status(500).send({ message: error })
// 		});
// }

async function azureFuncSummary(req, prompt, timeline=false){
    return new Promise(async function (resolve, reject) {
        const functionUrl = config.AF29URL + `/api/HttpTriggerSummarizer?code=${config.functionKey}`;
        axios.post(functionUrl, req.body.context, {
            params: {
                prompt: prompt,
                userId: req.body.userId,
				timeline: timeline
            },
            headers: {
                'Content-Type': 'application/json'
            },
        }).then(async response => {
            resolve(response);
        }).catch(error => {
          console.error("Error:", error);
          reject(error);
        });
    });
}
 
async function callTranscriptSummary(req, res) {
	let prompt = `Please provide a succinct summary of the conversation transcript. 
	Focus on identifying and highlighting the main points discussed, any conclusions reached, and specific actions or recommendations mentioned. 
	The summary should capture the essence of the conversation, making it easy for someone who did not participate in the conversation to understand its key outcomes and takeaways. 
	Start by briefly describing the context of the conversation (Always start with: "This conversation involves [participants] discussing [main topic]"), 
	followed by a clear and concise extraction of the most relevant points, 
	and conclude with any agreed-upon actions, decisions, or important remarks made during the discussion. 
	This summary is intended to provide a quick and comprehensive understanding of the conversation's content and conclusions.
	
	H3 Summary title: Summary of the conversation`;

	let prompt2 = `Please summarize the transcribed conversation, structuring the summary around the following key points:

	1. Reason for Consultation: Briefly detail the primary reason for initiating the conversation.
	
	2. Personal Background: Provide a summary of relevant personal background information mentioned during the conversation.
	
	3. Symptoms: List and describe the symptoms discussed, highlighting those that are most significant or recurrent.

	4. Complementary Tests: Describe any additional tests or examinations that were discussed as part of the diagnostic process.
	
	5. Possible Diagnosis: Identify and summarize any potential diagnoses that emerged during the conversation.
	
	6. Plan: Conclude with the plans, actions, or recommendations agreed upon, based on the analysis and discussions carried out.
	
	This summary should capture the conversation's most relevant aspects clearly and concisely, allowing for an easy understanding of the dialogue's flow and conclusions. Focus on how each of these points is developed and interconnected throughout the conversation.
	
	H3 Summary title: Structured summary to paste in the medical record`;


	// let promises = [
	// 	langchain.navigator_summarizeTranscript(req.body.userId, promt, req.body.conversation, req.body.context, 'Summary of the conversation'),
	// 	langchain.navigator_summarizeTranscript(req.body.userId, promt2, req.body.conversation, req.body.context, 'Structured summary to paste in the medical record')
	// ];

	let promises = [
		azureFuncSummary(req, prompt),
		azureFuncSummary(req, prompt2)
	];
	
	// Utilizar Promise.all para esperar a que todas las promesas se resuelvan
	let [result, result2] = await Promise.all(promises);

	if(result.data){
		let data = {
			nameFiles: req.body.nameFiles,
			promt: prompt,
			role: req.body.role,
			conversation: req.body.conversation,
			context: req.body.context,
			result: result.data
		}
		let nameurl = req.body.paramForm+'/summary.json';
		f29azureService.createBlobSimple('data', nameurl, data);
	}

	if(result2.data){
		let data = {
			nameFiles: req.body.nameFiles,
			promt: prompt2,
			role: req.body.role,
			conversation: req.body.conversation,
			context: req.body.context,
			result: result2.data
		}
		let nameurl = req.body.paramForm+'/summaryv2.json';
		f29azureService.createBlobSimple('data', nameurl, data);
	}

	let finalResult = {
		"msg": "done", 
		"result1": result.data,
		"result2": result2.data,
		"status": 200
		}

	res.status(200).send(finalResult);
}

async function callSummarydx(req, res) {
	/*let promt = `Please extract a rich set of information from the patient medical documents.
	Everything that could be useful for an expert doctor to understand the patient's situation.
	But also every that could be useful for the patient to understand his situation. And to be able to ask questions about it.
	The goal of this is to store the information in a clean way so that it can be used for further analysis in the future.  
	Starting with an overview of the documents type and its purposes, (Always start with: The documents you just uploaded are a [document type] and its purposes are to [purpose])
	then continue with an introduction of the patient,
	then extract all the medical information and sort it into all the possible general categories (e.g. diagnosis, treatment, medication, etc.),
	then if necessary, add non-medical information but relevant into the "Other" category.`;*/
	//let promt = 'Analyze the report and extract phenotypic characteristics, symptoms, test results, and other clinical details indicative of rare diseases. Provide a concise summary that highlights any findings potentially relevant for the diagnosis of rare diseases.';
	//let promt = 'Analyze the medical report and provide a concise summary that lists all the symptoms in a single paragraph. Exclude any mention of diseases, medications, genetic information, or test results.';
	let promt = 'Provide a paragraph listing only the symptoms from the medical report.';

	var result = await langchain.navigator_summarize_dx(req.body.userId, promt, req.body.conversation, req.body.context);
	if(result.response){
		let data = {
			nameFiles: req.body.nameFiles,
			promt: promt,
			role: 'Summarydx',
			conversation: req.body.conversation,
			context: req.body.context,
			result: result.response
		}
		let nameurl = req.body.paramForm+'/summary.json';
		f29azureService.createBlobSimple('data', nameurl, data);
	}
	res.status(200).send(result);
}

async function form_recognizer(userId, documentId, containerName, url) {
	return new Promise(async function (resolve, reject) {
		var url2 = "https://" + accountname + ".blob.core.windows.net/" + containerName + "/" + url + sas;
		const modelId = "prebuilt-layout"; // replace with your model id
		const endpoint = form_recognizer_endpoint; // replace with your endpoint
		const apiVersion = "2023-10-31-preview";
		const analyzeUrl = `${endpoint}/documentintelligence/documentModels/${modelId}:analyze?_overload=analyzeDocument&api-version=${apiVersion}&outputContentFormat=markdown`;

		const headers = {
			'Ocp-Apim-Subscription-Key': form_recognizer_key
		  };
		  
		  const body = {
			urlSource: url2
		  };
		  
		  axios.post(analyzeUrl, body, { headers: headers })
		  .then(async response => {
			
			const operationLocation = response.headers['operation-location'];
			let resultResponse;
			do {
			  resultResponse = await axios.get(operationLocation, { headers: headers });
			  if (resultResponse.data.status !== 'running') {
				break;
			  }
			  await new Promise(resolve => setTimeout(resolve, 1000));
			} while (true);
			
			// console.log(resultResponse);
			// console.log(resultResponse.data.error.details);
			let content = resultResponse.data.analyzeResult.content;

			const category_summary = await langchain.categorize_docs(userId, content);
	
			var response = {
			"msg": "done", 
			"data": content,
			"summary": category_summary,
			"doc_id": documentId, 
			"status": 200
			}

			const tokens = countTokens.countTokens(response.data);
			response.tokens = tokens;
			resolve(response);
		})
		.catch(error => {
		  console.error("Error in analyzing document:", error);
		  reject(error);
		});
	  }
	);
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
	callTranscriptSummary,
	callSummarydx,
	form_recognizer,
	anonymizeBooks,
	deleteBook,
	anonymizeDocument,
}
