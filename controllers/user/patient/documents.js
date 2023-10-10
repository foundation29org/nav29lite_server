// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Document = require('../../../models/document')
const crypt = require('../../../services/crypt')
const bookService = require("../../../services/books")
const langchain = require('../../../services/langchain')
const insights = require('../../../services/insights')

async function uploadFile(req, res) {
	if (req.files != null) {
		
	} else {
		insights.error('Error: no files');
		res.status(500).send({ message: `Error: no files` })
	}

}


async function trySummarize(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	//create blob
	var document = await findDocument(req.body.docId);
	if (document) {
		if(patientId == document.createdBy){
			langchain.summarize(patientId, req.body.containerName, document.url, req.body.docId, req.body.docName, req.body.userId);
			res.status(200).send({ message: "Done", docId: req.body.docId })
		}else{
			insights.error("Error 1 trySummarize");
			res.status(500).send({ message: `Error` })
		}
		
	} else {
		insights.error("Error 2 trySummarize");
		res.status(500).send({ message: `Error` })
	}

}


function findDocument(docId) {
	return new Promise((resolve, reject) => {
		Document.findById(docId, (err, document) => {
			if (err) {
				resolve(false);
			}
			resolve(document);
		}
		)
	});
  }


function anonymizeDocument(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let documentId = req.body.docId;
	Document.findById(documentId, (err, document) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (document && patientId == document.createdBy) {
			bookService.anonymizeDocument(document);
			res.status(200).send({ message: 'Done' })
		} else {
			insights.error("Error 2 anonymizeDocument");
			return res.status(404).send({ code: 208, message: `Error anonymizing the document: ${err}` })
		}

	})
}

module.exports = {
	uploadFile,
	trySummarize,
	anonymizeDocument
}
