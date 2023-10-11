// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Document = require('../../../models/document')
const crypt = require('../../../services/crypt')
const bookService = require("../../../services/books")
const langchain = require('../../../services/langchain')
const insights = require('../../../services/insights')
const f29azureService = require("../../../services/f29azure")
const path = require('path');

async function uploadFile(req, res) {
	let containerName = 'data';
	if (req.files != null) {
		var data1 = await saveBlob('data', req.body.url, req.files.thumbnail);
		if (data1) {
			const filename = path.basename(req.body.url);
			var result = await bookService.createBook(req.body.docId, containerName, req.body.url, filename);
			res.status(200).send(result)
		}
	} else {
		insights.error('Error: no files');
		res.status(500).send({ message: `Error: no files` })
	}

}

async function saveBlob(containerName, url, thumbnail) {
	return new Promise(async function (resolve, reject) {
		// Save file to Blob
		var result = await f29azureService.createBlob(containerName, url, thumbnail.data);
		if (result) {
			resolve(true);
		} else {
			resolve(false);
		}
	});
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
