// functions for each call of the api on patient. Use the patient model

'use strict'

// add the patient model
const Patient = require('../../models/patient')
const Document = require('../../models/document')
const User = require('../../models/user')
const Group = require('../../models/group')
const crypt = require('../../services/crypt')
const bookService = require("../../services/books")
const langchain = require('../../services/langchain')
const insights = require('../../services/insights')
const document = require('./patient/documents')

/**
 * @api {get} https://raito.care/api/patients-all/:userId Get patient list of a user
 * @apiName getPatientsUser
 * @apiDescription This method read the patient list of a user. For each patient you have, you will get: patientId, name, and last name.
 * @apiGroup Patients
 * @apiVersion 1.0.0
 * @apiExample {js} Example usage:
 *   this.http.get('https://raito.care/api/patients-all/'+userId)
 *    .subscribe( (res : any) => {
 *      console.log('patient list: '+ res.listpatients);
 *      if(res.listpatients.length>0){
 *        console.log("patientId" + res.listpatients[0].sub +", Patient Name: "+ res.listpatients[0].patientName+", Patient surname: "+ res.listpatients[0].surname);
 *      }
 *     }, (err) => {
 *      ...
 *     }
 *
 * @apiHeader {String} authorization Users unique access-key. For this, go to  [Get token](#api-Access_token-signIn)
 * @apiHeaderExample {json} Header-Example:
 *     {
 *       "authorization": "Bearer eyJ0eXAiOiJKV1QiLCJhbGciPgDIUzI1NiJ9.eyJzdWIiOiI1M2ZlYWQ3YjY1YjM0ZTQ0MGE4YzRhNmUyMzVhNDFjNjEyOThiMWZjYTZjMjXkZTUxMTA9OGVkN2NlODMxYWY3IiwiaWF0IjoxNTIwMzUzMDMwLCJlcHAiOjE1NTE4ODkwMzAsInJvbGUiOiJVc2VyIiwiZ3JvdDEiOiJEdWNoZW5uZSBQYXJlbnQgUHJfrmVjdCBOZXRoZXJsYW5kcyJ9.MloW8eeJ857FY7-vwxJaMDajFmmVStGDcnfHfGJx05k"
 *     }
 * @apiParam {String} userId User unique ID. More info here:  [Get token and userId](#api-Access_token-signIn)
 * @apiSuccess {Object} listpatients You get a list of patients (usually only one patient), with your patient id, name, and surname.
 * @apiSuccessExample Success-Response:
 * HTTP/1.1 200 OK
 * {"listpatients":
 *  {
 *   "sub": "1499bb6faef2c95364e2f4tt2c9aef05abe2c9c72110a4514e8c4c3fb038ff30",
 *   "patientName": "Jhon",
 *   "surname": "Doe"
 *  },
 *  {
 *   "sub": "5499bb6faef2c95364e2f4ee2c9aef05abe2c9c72110a4514e8c4c4gt038ff30",
 *   "patientName": "Peter",
 *   "surname": "Tosh"
 *  }
 * }
 *
 */

function getPatientsUser (req, res){
	let userId= crypt.decrypt(req.params.userId);


	User.findById(userId, {"_id" : false , "__v" : false, "confirmationCode" : false, "loginAttempts" : false, "lastLogin" : false}, (err, user) => {
		if (err){
			insights.error(err)
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!user){
			insights.error("The user does not exist")
			return res.status(404).send({code: 208, message: 'The user does not exist'})
		}
		if(user.role == 'User'){
			Patient.find({"createdBy": userId},(err, patients) => {
				if (err){
					insights.error(err)
					return res.status(500).send({message: `Error making the request: ${err}`})
				}

				var listpatients = [];

				patients.forEach(function(u) {
					var id = u._id.toString();
					var idencrypt= crypt.encrypt(id);
					listpatients.push({sub:idencrypt, patientName: u.patientName, surname: u.surname, birthDate: u.birthDate, gender: u.gender, country: u.country, group: u.group});
				});

				//res.status(200).send({patient, patient})
				// if the two objects are the same, the previous line can be set as follows
				res.status(200).send({listpatients})
			})
		}else if(user.role == 'Clinical' || user.role == 'SuperAdmin' || user.role == 'Admin'){

			//debería de coger los patientes creados por ellos, más adelante, habrá que meter tb los pacientes que les hayan datos permisos
			Patient.find({"createdBy": userId},(err, patients) => {
				if (err){
					insights.error(err)
					return res.status(500).send({message: `Error making the request: ${err}`})
				}

				var listpatients = [];

				patients.forEach(function(u) {
					var id = u._id.toString();
					var idencrypt= crypt.encrypt(id);
					listpatients.push({sub:idencrypt, patientName: u.patientName, surname: u.surname, isArchived: u.isArchived, birthDate: u.birthDate, gender: u.gender, country: u.country, group: u.group});
				});

				//res.status(200).send({patient, patient})
				// if the two objects are the same, the previous line can be set as follows
				res.status(200).send({listpatients})
			})
		}else{
			res.status(401).send({message: 'without permission'})
		}
	})


}


async function getStatePatientSummary(req, res){
	let patientId= crypt.decrypt(req.params.patientId);
	const userId = req.body.userId;
	const regenerate = req.body.regenerate;
	//if docs.length == 0, and events.length == 0, then return error
	let numInfo = await document.getDocsAndEvents(req.params.patientId);
	if(numInfo.length == 0){
		insights.error("The patient does not have any information")
		return res.status(202).send({summary: `The patient does not have any information`})
	}else{
		Patient.findById(patientId, (err, patient) => {
			if (err){
				insights.error(err)
				return res.status(500).send({message: `Error making the request: ${err}`})
			}
			if(!patient){
				insights.error("The patient does not exist")
				return res.status(202).send({message: `The patient does not exist`})
			}
			if(patient.summary=='false' || (regenerate && patient.summary=='true')){
				setStatePatientSummary(patientId, 'inProcess');
				createPatientSummary(patientId, userId);
				res.status(200).send({summary: 'inProcess', summaryDate: patient.summaryDate})
			}else{
				res.status(200).send({summary: patient.summary, summaryDate: patient.summaryDate})
			}
		})
	}
	
}

function setStatePatientSummary(patientId, state) {
	let actualDate = new Date();
	Patient.findByIdAndUpdate(patientId, { summary: state, summaryDate: actualDate}, { new: true }, (err, patientUpdated) => {
		if (err){
			insights.error(err);
			console.log(err)
		} 
		if (!patientUpdated){
			insights.error('Error updating patient summary');
			console.log('Error updating patient summary')
		}
		else{
			console.log(patientUpdated.toObject())
			console.log('patient summary updated')
		} 
	})
}

async function createPatientSummary(patientId, userId) {  
  await langchain.summarizePatient(patientId, userId)
    .then((summary) => {
		setStatePatientSummary(patientId, 'true');
    })
    .catch((err) => {
		insights.error(err);
		console.log(err)
		setStatePatientSummary(patientId, 'false');
    });
}

/**
 * @api {get} https://raito.care/api/patients/:patientId Get patient
 * @apiName getPatient
 * @apiDescription This method read data of a Patient
 * @apiGroup Patients
 * @apiVersion 1.0.0
 * @apiExample {js} Example usage:
 *   this.http.get('https://raito.care/api/patients/'+patientId)
 *    .subscribe( (res : any) => {
 *      console.log('patient info: '+ res.patient);
 *     }, (err) => {
 *      ...
 *     }
 *
 * @apiHeader {String} authorization Users unique access-key. For this, go to  [Get token](#api-Access_token-signIn)
 * @apiHeaderExample {json} Header-Example:
 *     {
 *       "authorization": "Bearer eyJ0eXAiOiJKV1QiLCJhbGciPgDIUzI1NiJ9.eyJzdWIiOiI1M2ZlYWQ3YjY1YjM0ZTQ0MGE4YzRhNmUyMzVhNDFjNjEyOThiMWZjYTZjMjXkZTUxMTA9OGVkN2NlODMxYWY3IiwiaWF0IjoxNTIwMzUzMDMwLCJlcHAiOjE1NTE4ODkwMzAsInJvbGUiOiJVc2VyIiwiZ3JvdDEiOiJEdWNoZW5uZSBQYXJlbnQgUHJfrmVjdCBOZXRoZXJsYW5kcyJ9.MloW8eeJ857FY7-vwxJaMDajFmmVStGDcnfHfGJx05k"
 *     }
 * @apiParam {String} patientId Patient unique ID. More info here:  [Get patientId](#api-Patients-getPatientsUser)
 * @apiSuccess {string="male","female"} gender Gender of the Patient.
 * @apiSuccess {String} phone1 Phone number of the Patient.
 * @apiSuccess {String} phone2 Other phone number of the Patient.
 * @apiSuccess {String} country Country code of residence of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiSuccess {String} province Province or region code of residence of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiSuccess {String} city City of residence of the Patient.
 * @apiSuccess {String} postalCode PostalCode of residence of the Patient.
 * @apiSuccess {String} street Street of residence of the Patient.
 * @apiSuccess {String} countrybirth Country birth of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiSuccess {String} provincebirth Province birth of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiSuccess {String} citybirth City birth of the Patient.
 * @apiSuccess {Date} birthDate Date of birth of the patient.
 * @apiSuccess {String} patientName Name of the Patient.
 * @apiSuccess {String} surname Surname of the Patient.
 * @apiSuccess {Object} parents Data about parents of the Patient. The highEducation field can be ... The profession field is a free field
 * @apiSuccess {Object} siblings Data about siblings of the Patient. The affected field can be yes or no. The gender field can be male or female
 * @apiSuccessExample Success-Response:
 * HTTP/1.1 200 OK
 * {"patient":
 *   {
 *     "gender":"male",
 *     "phone2":"",
 *     "phone1":"",
 *     "country":"NL",
 *     "province":"Groningen",
 *     "city":"narnias",
 *     "postalCode":"",
 *     "street":"",
 *     "countrybirth":"SL",
 *     "provincebirth":"Barcelona",
 *     "citybirth":"narnia",
 *     "birthDate":"1984-06-13T00:00:00.000Z",
 *     "surname":"aa",
 *     "patientName":"aa",
 *     "parents":[{"_id":"5a6f4b71f600d806044f3ef5","profession":"","highEducation":""}],
 *     "siblings":[{"_id":"5a6f4b71f600d806044f3ef4","affected":null,"gender":""}]
 *   }
 * }
 *
 */

function getPatient (req, res){
	let patientId= crypt.decrypt(req.params.patientId);

	Patient.findById(patientId, {"_id" : false , "createdBy" : false }, (err, patient) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!patient){
			insights.error(`The patient does not exist`);
			return res.status(202).send({message: `The patient does not exist`})
		}

		res.status(200).send({patient})
	})
}


/**
 * @api {put} https://raito.care/api/patients/:patientId Update Patient
 * @apiName updatePatient
 * @apiDescription This method allows to change the data of a patient.
 * @apiGroup Patients
 * @apiVersion 1.0.0
 * @apiExample {js} Example usage:
 *   var patient = {patientName: '', surname: '', street: '', postalCode: '', citybirth: '', provincebirth: '', countrybirth: null, city: '', province: '', country: null, phone1: '', phone2: '', birthDate: null, gender: null, siblings: [], parents: []};
 *   this.http.put('https://raito.care/api/patients/'+patientId, patient)
 *    .subscribe( (res : any) => {
 *      console.log('patient info: '+ res.patientInfo);
 *     }, (err) => {
 *      ...
 *     }
 *
 * @apiHeader {String} authorization Users unique access-key. For this, go to  [Get token](#api-Access_token-signIn)
 * @apiHeaderExample {json} Header-Example:
 *     {
 *       "authorization": "Bearer eyJ0eXAiOiJKV1QiLCJhbGciPgDIUzI1NiJ9.eyJzdWIiOiI1M2ZlYWQ3YjY1YjM0ZTQ0MGE4YzRhNmUyMzVhNDFjNjEyOThiMWZjYTZjMjXkZTUxMTA9OGVkN2NlODMxYWY3IiwiaWF0IjoxNTIwMzUzMDMwLCJlcHAiOjE1NTE4ODkwMzAsInJvbGUiOiJVc2VyIiwiZ3JvdDEiOiJEdWNoZW5uZSBQYXJlbnQgUHJfrmVjdCBOZXRoZXJsYW5kcyJ9.MloW8eeJ857FY7-vwxJaMDajFmmVStGDcnfHfGJx05k"
 *     }
 * @apiParam {String} patientId Patient unique ID. More info here:  [Get patientId](#api-Patients-getPatientsUser)
 * @apiParam (body) {string="male","female"} gender Gender of the Patient.
 * @apiParam (body) {String} phone1 Phone number of the Patient.
 * @apiParam (body) {String} phone2 Other phone number of the Patient.
 * @apiParam (body) {String} country Country code of residence of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiParam (body) {String} province Province or region code of residence of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiParam (body) {String} city City of residence of the Patient.
 * @apiParam (body) {String} [postalCode] PostalCode of residence of the Patient.
 * @apiParam (body) {String} [street] Street of residence of the Patient.
 * @apiParam (body) {String} countrybirth Country birth of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiParam (body) {String} provincebirth Province birth of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiParam (body) {String} citybirth City birth of the Patient.
 * @apiParam (body) {Date} birthDate Date of birth of the patient.
 * @apiParam (body) {String} patientName Name of the Patient.
 * @apiParam (body) {String} surname Surname of the Patient.
 * @apiParam (body) {Object} [parents] Data about parents of the Patient. The highEducation field can be ... The profession field is a free field
 * @apiParam (body) {Object} [siblings] Data about siblings of the Patient. The affected field can be yes or no. The gender field can be male or female
 * @apiSuccess {Object} patientInfo patientId, name, and surname.
 * @apiSuccess {String} message If the patient has been created correctly, it returns the message 'Patient updated'.
 * @apiSuccessExample Success-Response:
 * HTTP/1.1 200 OK
 * {"patientInfo":
 *  {
 *   "sub": "1499bb6faef2c95364e2f4tt2c9aef05abe2c9c72110a4514e8c4c3fb038ff30",
 *   "patientName": "Jhon",
 *   "surname": "Doe"
 *  },
 * "message": "Patient updated"
 * }
 *
 */

function updatePatient (req, res){
	let patientId= crypt.decrypt(req.params.patientId);
	let update = req.body
  var avatar = '';
  if(req.body.avatar==undefined){
    if(req.body.gender!=undefined){
      if(req.body.gender=='male'){
				avatar='boy-0'
			}else if(req.body.gender=='female'){
				avatar='girl-0'
			}
    }
  }else{
    avatar = req.body.avatar;
  }
  if(req.body.deleteConsent!=undefined){
	if(req.body.deleteConsent){
		req.body.consentgroup='false';
	}
  }

  Patient.findByIdAndUpdate(patientId, { gender: req.body.gender, birthDate: req.body.birthDate, patientName: req.body.patientName, surname: req.body.surname, relationship: req.body.relationship, country: req.body.country, avatar: avatar, group: req.body.group, consentgroup: req.body.consentgroup }, {new: true}, async (err,patientUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		var id = patientUpdated._id.toString();
		var idencrypt= crypt.encrypt(id);
		var patientInfo = {sub:idencrypt, patientName: patientUpdated.patientName, surname: patientUpdated.surname, birthDate: patientUpdated.birthDate, gender: patientUpdated.gender, country: patientUpdated.country, avatar: patientUpdated.avatar, group: patientUpdated.group, consentgroup: patientUpdated.consentgroup};
		res.status(200).send({message: 'Patient updated', patientInfo})

	})
}

function consentgroup (req, res){

	let patientId= crypt.decrypt(req.params.patientId);//crypt.decrypt(req.params.patientId);
	var newConsent = req.body.consentgroup;
	Patient.findByIdAndUpdate(patientId, { consentgroup: newConsent }, {select: '-createdBy', new: true}, (err,patientUpdated) => {
		res.status(200).send({message: 'consent changed', consent: newConsent})

	})
}

function getConsentGroup (req, res){

	let patientId= crypt.decrypt(req.params.patientId);//crypt.decrypt(req.params.patientId);

	Patient.findById(patientId, {"_id" : false , "createdBy" : false }, (err,patient) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		res.status(200).send({consentgroup: patient.consentgroup})

	})
}

function setChecks (req, res){

	let patientId= crypt.decrypt(req.params.patientId);//crypt.decrypt(req.params.patientId);

	Patient.findByIdAndUpdate(patientId, { checks: req.body.checks }, {select: '-createdBy', new: true}, (err,patientUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}

		res.status(200).send({message: 'checks changed'})

	})
}

function getChecks (req, res){

	let patientId= crypt.decrypt(req.params.patientId);//crypt.decrypt(req.params.patientId);

	Patient.findById(patientId, {"_id" : false , "createdBy" : false }, (err,patient) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		res.status(200).send({checks: patient.checks})

	})
}

function setBirthDate (req, res){

	let patientId= crypt.decrypt(req.params.patientId);

	Patient.findByIdAndUpdate(patientId, { birthDate: req.body.birthDate }, {select: '-createdBy', new: true}, (err,patientUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}

		res.status(200).send({message: 'birthDate changed'})

	})
}


function getDonation (req, res){

	let patientId= crypt.decrypt(req.params.patientId);//crypt.decrypt(req.params.patientId);

	Patient.findById(patientId, {"_id" : false , "createdBy" : false }, (err,patient) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		res.status(200).send({donation: patient.donation})

	})
}

function setDonation (req, res){

	let patientId= crypt.decrypt(req.params.patientId);

	Patient.findByIdAndUpdate(patientId, { donation: req.body.donation }, {select: '-createdBy', new: true}, async (err,patientUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(req.body.donation){
			//ver si tiene documentos pendientes de anonimizar
			const documents = await findDocumentsWithoutAnonymization(patientId);
			if(documents.length>0){
				bookService.anonymizeBooks(documents);
				res.status(200).send({message: 'donation changed', documents: documents.length})
			}else{
				res.status(200).send({message: 'donation changed'})
			}
		}else{
			res.status(200).send({message: 'donation changed'})
		}
	})
}

function findDocumentsWithoutAnonymization(patientId) {
	return new Promise((resolve, reject) => {
	  Document.find(
		{ createdBy: patientId, anonymized: 'false'},
		(err, eventsdb) => {
		  if (err) {
			reject(err);
		  } else {
			const plainDocuments = eventsdb.map((doc) => doc.toObject());
			resolve(plainDocuments);
		  }
		}
	  );
	});
  }

module.exports = {
	getPatientsUser,
	getPatient,
	getStatePatientSummary,
	setStatePatientSummary,
	createPatientSummary,
	updatePatient,
	consentgroup,
	getConsentGroup,
	setChecks,
	getChecks,
	setBirthDate,
	getDonation,
	setDonation
}
