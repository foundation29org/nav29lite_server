// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')

const translationCtrl = require('../services/translation')
const bookServiceCtrl2 = require('../services/books')
const docsCtrl = require('../controllers/user/patient/documents')
const cors = require('cors');
const serviceEmail = require('../services/email')
const emailThrottle = require('../utils/emailThrottle')

const api = express.Router()
const config= require('../config')
const myApiKey = config.Server_Key;
// Lista de dominios permitidos
const whitelist = config.allowedOrigins;

  // Middleware personalizado para CORS
  function corsWithOptions(req, res, next) {
    const corsOptions = {
      origin: function (origin, callback) {
        console.log(origin);
        if (whitelist.includes(origin)) {
          callback(null, true);
        } else {
            const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            const requestInfo = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                origin: origin,
                body: req.body,
                ip: clientIp,
                params: req.params,
                query: req.query,
              };
            
            // Solo enviar email si pasa el throttle
            if (emailThrottle.shouldSendEmail(clientIp, requestInfo)) {
              const aggregatedInfo = emailThrottle.getAggregatedInfo(clientIp);
              requestInfo.attemptCount = aggregatedInfo.attemptCount;
              requestInfo.previousAttempts = aggregatedInfo.attempts;
              serviceEmail.sendMailControlCall(requestInfo);
            }
            
            callback(new Error('Not allowed by CORS'));
        }
      },
    };
  
    cors(corsOptions)(req, res, next);
  }

  const checkApiKey = (req, res, next) => {
    // Permitir explícitamente solicitudes de tipo OPTIONS para el "preflight" de CORS
    if (req.method === 'OPTIONS') {
      return next();
    } else {
      const apiKey = req.get('x-api-key');
      if (apiKey && apiKey === myApiKey) {
        return next();
      } else {
        return res.status(401).json({ error: 'API Key no válida o ausente' });
      }
    }
  };

// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)

// Ruta opcional para ver estadísticas de intentos bloqueados (protegida con API key)
api.get('/security/stats', checkApiKey, (req, res) => {
  const stats = emailThrottle.getStats();
  res.status(200).json(stats);
})


// documentsCtrl routes, using the controller documents, this controller has methods

api.post('/upload', corsWithOptions, checkApiKey, docsCtrl.uploadFile)
api.post('/callnavigator', corsWithOptions, checkApiKey, bookServiceCtrl2.callNavigator)
api.post('/callsummary', corsWithOptions, checkApiKey, bookServiceCtrl2.callSummary)
api.post('/calltranscriptsummary', corsWithOptions, checkApiKey, bookServiceCtrl2.callTranscriptSummary)
api.post('/calldxsummary', corsWithOptions, checkApiKey, bookServiceCtrl2.callSummarydx)

//translations
api.post('/getDetectLanguage', corsWithOptions, checkApiKey, translationCtrl.getDetectLanguage)
api.post('/translation', corsWithOptions, checkApiKey, translationCtrl.getTranslationDictionary)
api.post('/translationinvert', corsWithOptions, checkApiKey, translationCtrl.getTranslationDictionaryInvert)
api.post('/translationinvertarray', corsWithOptions, checkApiKey, translationCtrl.getTranslationDictionaryInvert2)
api.post('/deepltranslationinvert', corsWithOptions, checkApiKey, translationCtrl.getdeeplTranslationDictionaryInvert)
api.post('/translation/segments', corsWithOptions, checkApiKey, translationCtrl.getTranslationSegments)



//ruta privada
api.get('/private', (req, res) => {
	res.status(200).send({ message: 'You have access' })
})

module.exports = api
