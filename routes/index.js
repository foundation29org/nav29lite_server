// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')

const translationCtrl = require('../services/translation')
const openAIserviceCtrl = require('../services/openai')
const bookServiceCtrl2 = require('../services/books')
const docsCtrl = require('../controllers/user/patient/documents')
const taCtrl = require('../services/ta')
const cors = require('cors');
const serviceEmail = require('../services/email')

const api = express.Router()

// const whitelist = ['https://nav29lite.azurewebsites.net'];
const whitelist = ['https://nav29lite.azurewebsites.net', 'http://localhost:4200'];

  // Middleware personalizado para CORS
  function corsWithOptions(req, res, next) {
    const corsOptions = {
      origin: function (origin, callback) {
        console.log(origin);
        if (whitelist.includes(origin)) {
          callback(null, true);
        } else {
            // La IP del cliente
            const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            const requestInfo = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                origin: origin,
                body: req.body, // Asegúrate de que el middleware para parsear el cuerpo ya haya sido usado
                ip: clientIp,
                params: req.params,
                query: req.query,
              };
            serviceEmail.sendMailControlCall(requestInfo)
            callback(new Error('Not allowed by CORS'));
        }
      },
    };
  
    cors(corsOptions)(req, res, next);
  }

// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)


// documentsCtrl routes, using the controller documents, this controller has methods

api.post('/upload', corsWithOptions, docsCtrl.uploadFile)
api.post('/callnavigator', corsWithOptions, bookServiceCtrl2.callNavigator)
api.post('/callsummary', corsWithOptions, bookServiceCtrl2.callSummary)

api.post('/trysummarize/:patientId', corsWithOptions, docsCtrl.trySummarize)
api.post('/anonymizedocument/:patientId', corsWithOptions, docsCtrl.anonymizeDocument)

api.post('/analizeDoc', corsWithOptions, bookServiceCtrl2.analizeDoc)

//services OPENAI
api.post('/callopenaicontext', corsWithOptions, openAIserviceCtrl.callOpenAiContext)

//translations
api.post('/getDetectLanguage', corsWithOptions, translationCtrl.getDetectLanguage)
api.post('/translation', corsWithOptions, translationCtrl.getTranslationDictionary)
api.post('/translationinvert', corsWithOptions, translationCtrl.getTranslationDictionaryInvert)
api.post('/translationinvertarray', corsWithOptions, translationCtrl.getTranslationDictionaryInvert2)
api.post('/deepltranslationinvert', corsWithOptions, translationCtrl.getdeeplTranslationDictionaryInvert)
api.post('/translation/segments', corsWithOptions, translationCtrl.getTranslationSegments)

//ta
api.post('/callTextAnalytics', corsWithOptions, taCtrl.callTextAnalytics)



//ruta privada
api.get('/private', (req, res) => {
	res.status(200).send({ message: 'You have access' })
})

module.exports = api
