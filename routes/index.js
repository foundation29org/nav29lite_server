// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')

const translationCtrl = require('../services/translation')
const openAIserviceCtrl = require('../services/openai')
const bookServiceCtrl2 = require('../services/books')
const docsCtrl = require('../controllers/user/patient/documents')
const taCtrl = require('../services/ta')


const api = express.Router()



// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)


// documentsCtrl routes, using the controller documents, this controller has methods

api.post('/upload', docsCtrl.uploadFile)
api.post('/callnavigator', bookServiceCtrl2.callNavigator)
api.post('/callsummary', bookServiceCtrl2.callNavigator)

api.post('/trysummarize/:patientId', docsCtrl.trySummarize)
api.post('/anonymizedocument/:patientId', docsCtrl.anonymizeDocument)

api.post('/analizeDoc', bookServiceCtrl2.analizeDoc)

//services OPENAI
api.post('/callopenaicontext', openAIserviceCtrl.callOpenAiContext)

//translations
api.post('/getDetectLanguage', translationCtrl.getDetectLanguage)
api.post('/translation', translationCtrl.getTranslationDictionary)
api.post('/translationinvert', translationCtrl.getTranslationDictionaryInvert)
api.post('/translationinvertarray', translationCtrl.getTranslationDictionaryInvert2)
api.post('/deepltranslationinvert', translationCtrl.getdeeplTranslationDictionaryInvert)
api.post('/translation/segments', translationCtrl.getTranslationSegments)

//ta
api.post('/callTextAnalytics', taCtrl.callTextAnalytics)



//ruta privada
api.get('/private', (req, res) => {
	res.status(200).send({ message: 'You have access' })
})

module.exports = api
