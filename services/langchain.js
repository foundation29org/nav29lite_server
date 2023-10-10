const { ChatOpenAI } = require("langchain/chat_models/openai");
const { PromptTemplate } = require("langchain/prompts");
const { loadSummarizationChain, LLMChain } = require("langchain/chains");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const Events = require('../models/events')
const config = require('../config')
const pubsub = require('../services/pubsub');
const translate = require('../services/translation');
const crypt = require('../services/crypt');
const insights = require('../services/insights');
const { Client } = require("langsmith")
const { LangChainTracer } = require("langchain/callbacks");
const { ChatBedrock } = require("langchain/chat_models/bedrock");

const OPENAI_API_KEY = config.OPENAI_API_KEY;
const OPENAI_API_VERSION = config.OPENAI_API_VERSION;
const OPENAI_API_BASE = config.OPENAI_API_BASE;
const client = new Client({
  apiUrl: "https://api.smith.langchain.com",
  apiKey: config.LANGSMITH_API_KEY,
});
const BEDROCK_API_KEY = config.BEDROCK_USER_KEY;
const BEDROCK_API_SECRET = config.BEDROCK_USER_SECRET;

function createModels(projectName) {
  const tracer = new LangChainTracer({
    projectName: projectName,
    client
  });
  
  const model = new ChatOpenAI({
    modelName: "gpt-4-0613",
    azureOpenAIApiKey: OPENAI_API_KEY,
    azureOpenAIApiVersion: OPENAI_API_VERSION,
    azureOpenAIApiInstanceName: OPENAI_API_BASE,
    azureOpenAIApiDeploymentName: "nav29",
    temperature: 0,
    timeout: 500000,
    callbacks: [tracer],
  });
  
  const model32k = new ChatOpenAI({
    modelName: "gpt-4-32k-0613",
    azureOpenAIApiKey: OPENAI_API_KEY,
    azureOpenAIApiVersion: OPENAI_API_VERSION,
    azureOpenAIApiInstanceName: OPENAI_API_BASE,
    azureOpenAIApiDeploymentName: "test32k",
    temperature: 0,
    timeout: 500000,
    callbacks: [tracer],
  });

  const claude2 = new ChatBedrock({
    model: "anthropic.claude-v2",
    region: "us-east-1",
    endpointUrl: "bedrock-runtime.us-east-1.amazonaws.com",
    credentials: {
       accessKeyId: BEDROCK_API_KEY,
       secretAccessKey: BEDROCK_API_SECRET,
    },
    temperature: 0,
    maxTokens: 8191,
    timeout: 500000,
    callbacks: [tracer],
  });
  
  return { model, model32k, claude2 };
}

const combine_map_prompt = new PromptTemplate({
  inputVariables: ["text"],
  template: `Write a concise summary of the following text, only including patient information or medical information relevant to the patient, and ESPECIALLY ALWAYS any anomalies found:
  "{text}"
  ---
  CONCISE MEDICAL SUMMARY:

  ---
  ANOMALIES in the analysis results (if present):

  `,
});

const combine_prompt = new PromptTemplate({
  inputVariables: ["text"],
  template: `Please provide a brief summary of the following medical document,
  starting with an overview of the document type and its purpose, (Always start with: The document you just uploaded is a [document type] and its purpose is to [purpose])
  then continue with an introduction of the patient, 
  then add a list of bullet points highlighting the anomalies found in the analysis results,
  and finally continue with a list of bullet points highlighting the key patient 
  or medical information relevant to the patient.
  The documents to be summarized is provided between the triple quotes.
  """
  {text}
  """
  ---
  Don't output anything more than the following JSON. Even if you don't have all the information, you should output ONLY the JSON with all the keys but only the values you have.
  Please provide your response in the form of a JSON object with the following keys if possible or empty:
  - 'DocumentPurpose'
  - 'PatientIntroduction'
  - 'Anomalies', which should be an array of bullet points.
  - 'KeyInformation', which should be an array of bullet points.
  Always output the JSON with that keys at least with "Not provided" if missing.
  `,
});

const combine_clean_prompt = new PromptTemplate({
  inputVariables: ["text"],
  template: `Return the following text after cleaning it from any irrelevant information.
  Remember to keep ALL the medical information and the patient information. Or any information related to medical events.
  Everything that could be useful for an expert doctor to understand the patient's situation.
  But also every that could be useful for the patient to understand his situation. And to be able to ask questions about it.
  The goal of this is to store the information in a clean way so that it can be used for further analysis in the future.
  The documents to be cleaned is provided between the triple quotes.
  """
  {text}
  """
  ---
  CLEANED TEXT:
  `,
});

const combine_extract_prompt = new PromptTemplate({
  inputVariables: ["text"],
  template: `Please extract a rich set of information from the following medical document.
  Everything that could be useful for an expert doctor to understand the patient's situation.
  But also every that could be useful for the patient to understand his situation. And to be able to ask questions about it.
  The goal of this is to store the information in a clean way so that it can be used for further analysis in the future.  
  Starting with an overview of the document type and its purpose, (Always start with: The document you just uploaded is a [document type] and its purpose is to [purpose])
  then continue with an introduction of the patient,
  then extract all the medical information and sort it into all the possible general categories (e.g. diagnosis, treatment, medication, etc.),
  then if necessary, add non-medical information but relevant into the "Other" category,
  The documents to be extracted is provided between the text tags.
  <text>{text}</text>
  ---
  Output it in a .txt file with the following format:
  Overview of the document type and its purpose:
  br
  Patient introduction:
  br
  Medical information:
  br
  Other information:
  ---
  EXTRACTED TEXT:
  `,
});

async function getActualEvents(patientId) {
  return new Promise((resolve, reject) => {
    Events.find({ "createdBy": patientId }, { "createdBy": false }, (err, eventsdb) => {
      if (err) {
        reject(err);
      } else {
        var listEventsdb = [];

        eventsdb.forEach(function (eventdb) {
          if(eventdb.checked){
            let types = ["symptom", "drug", "allergy", "disease", "treatment", "gene", "other" ,"anomalies"];
            if(types.includes(eventdb.type)){
              listEventsdb.push(eventdb);
            }
          }
        });

        resolve(listEventsdb);
      }
    });
  });
}

async function getMostCommonLanguage(blobs, containerName) {
  try {
    // Get the language of the original documents (download from blob)
    const languageCounts = {};
    for (const blob of blobs) {
      if (blob.endsWith("language.txt")) {
        const language = 'en';
        if (languageCounts[language]) {
          languageCounts[language]++;
        } else {
          languageCounts[language] = 1;
        }
      }
    }

    // Find the language with the highest count
    let mostCommonLanguage = null;
    let highestCount = 0;
    for (const language in languageCounts) {
      if (languageCounts[language] > highestCount) {
        mostCommonLanguage = language;
        highestCount = languageCounts[language];
      }
    }

    return mostCommonLanguage;
  } catch (error) {
    insights.error(error);
    console.error(error);
    throw error;
  }
}

async function translateText(text, deepl_code) {
  if (deepl_code == null) {
    // Do an Inverse Translation
    const info = [{ "Text": text }];
    const inverseTranslatedText = await translate.getTranslationDictionaryInvertMicrosoft2(info, doc_lang);
    return inverseTranslatedText[0].translations[0].text;
  } else {
    // Do a Translation
    return await translate.deepLtranslate(text, deepl_code);
  }
}

async function summarize(patientId, containerName, url, doc_id, filename, userId) {
  try {
    const message = {"docId": doc_id, "status": "creando resumen", "filename": filename}
    pubsub.sendToUser(userId, message)
    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { model, model32k, claude2 } = createModels(projectName);
    // In this example, we use a `MapReduceDocumentsChain` specifically prompted to summarize a set of documents.
    let url2 = url.replace(/\/[^\/]*$/, '/extracted_translated.txt');
    let lang_url = url.replace(/\/[^\/]*$/, '/language.txt');
    let text, doc_lang;
    try {
      // Try to download the translation
      text = await azure_blobs.downloadBlob(containerName, url2);
      doc_lang = await azure_blobs.downloadBlob(containerName, lang_url);
    } catch (error) {
      insights.error(error);
      console.error('Error downloading the translated blob:', error);
      // Handle the error and make a different call here
      // For example:
      let url3 = url.replace(/\/[^\/]*$/, '/extracted.txt');
      text = await azure_blobs.downloadBlob(containerName, url3);
    }
    const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 100000 });
    const docs = await textSplitter.createDocuments([text]);

    chain = loadSummarizationChain(model32k, {
      type: "map_reduce",
      returnIntermediateSteps: true,
      combineMapPrompt: combine_map_prompt,
      combinePrompt: combine_prompt,
    });

    const res = await chain.call({
      input_documents: docs,
    });
    
    // Extract JSON from the string
    let match
    try{
      match = res.text.match(/\{(.|\n)*\}/);
    } catch (error) {
      console.error('Error extracting JSON from the string:', error);
      match = [{}];
    }
    
    // Create a blob with the summary
    const blob_response = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/summary_translated.txt'), match[0])
    
    // Parse the summary into JSON
    let summaryJson, jsonString;

    if (match) {
      jsonString = match[0];
      try {
        summaryJson = JSON.parse(jsonString);
        // Rest of the code...
      } catch (error) {
        console.error('Failed to parse JSON:', jsonString);
      }
    } else {
      console.error('No JSON object found in the string');
    }
    
    // Check if the doc_lang is available in DeepL
    deepl_code = await translate.getDeeplCode(doc_lang);

    // Loop through the JSON and translate the values
    for (let key in summaryJson) {
      if(Array.isArray(summaryJson[key])) {
        // Translate each item in the array
        for(let i = 0; i < summaryJson[key].length; i++) {
          summaryJson[key][i] = await translateText(summaryJson[key][i], deepl_code);
        }
      } else {
        // Translate the string
        summaryJson[key] = await translateText(summaryJson[key], deepl_code);
      }
    }
    
    // Reassemble the translated JSON into a string
    const translatedSummary = JSON.stringify(summaryJson);
    
    const blob_response2 = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/summary.txt'), translatedSummary)
    
    // Alert the client that the summary is ready (change status in the message)
    message.status = "resumen ready"
    pubsub.sendToUser(userId, message)
  } catch (error) {
    console.log("Error happened: ", error)
    insights.error(error);
    pubsub.sendToUser(userId, {"docId": doc_id, "status": "error summarize", "filename": filename, "error": error})
  };
}

async function clean_and_extract(patientId, containerName, url, doc_id, filename, userId) {
  try {
    const message = {"docId": doc_id, "status": "limpiando texto", "filename": filename}
    pubsub.sendToUser(userId, message)
    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { model, model32k, claude2 } = createModels(projectName);
    
    let url2 = url.replace(/\/[^\/]*$/, '/extracted_translated.txt');
    let lang_url = url.replace(/\/[^\/]*$/, '/language.txt');
    let text, doc_lang;
    try {
      text = await azure_blobs.downloadBlob(containerName, url2);
      doc_lang = await azure_blobs.downloadBlob(containerName, lang_url);
    } catch (error) {
      insights.error(error);
      console.error('Error downloading the translated blob:', error);
      let url3 = url.replace(/\/[^\/]*$/, '/extracted.txt');
      text = await azure_blobs.downloadBlob(containerName, url3);
    }

    // const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000000 });
    // const docs = await textSplitter.createDocuments([text]);

    // chain = loadSummarizationChain(claude2, {
    //   type: "map_reduce",
    //   returnIntermediateSteps: true,
    //   combineMapPrompt: combine_clean_prompt,
    //   combinePrompt: combine_extract_prompt,
    // });
    // const chain = new LLMChain({
    //   llm: claude2,
    //   prompt: combine_extract_prompt,
    // });

    // const res = await chain.call({
    //   text: text,
    // });

    const res = await claude2.callPrompt(
      await combine_extract_prompt.formatPromptValue({
        text: text,
      })
    );
    console.log(res);
    
    const blob_response = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/clean_translated.txt'), res.content)

    deepl_code = await translate.getDeeplCode(doc_lang);

    translatedText = await translateText(res.content, deepl_code);
    
    const blob_response2 = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/clean.txt'), translatedText)
    
    // Alert the client that the summary is ready (change status in the message)
    message.status = "clean ready"
    pubsub.sendToUser(userId, message)
  } catch (error) {
    console.log("Error happened: ", error)
    insights.error(error);
    pubsub.sendToUser(userId, {"docId": doc_id, "status": "error cleaning", "filename": filename, "error": error})
  };
}

async function anonymize(patientId, containerName, url, doc_id, filename, userId) {
  return new Promise(async (resolve, reject) => {
    try {
      let url2 = url.replace(/\/[^\/]*$/, '/fast_extracted_translated.txt');
      let lang_url = url.replace(/\/[^\/]*$/, '/language.txt');
      let text, doc_lang;

      try {
        // Try to download the translation
        text = await azure_blobs.downloadBlob(containerName, url2);
        doc_lang = await azure_blobs.downloadBlob(containerName, lang_url);
        //.log("Lang: ", doc_lang);
      } catch (error) {
        insights.error(error);
        console.error('Error downloading the translated blob:', error);
        // Handle the error and make a different call here
        // For example:
        let url3 = url.replace(/\/[^\/]*$/, '/fast_extracted.txt');
        text = await azure_blobs.downloadBlob(containerName, url3);
      }

      // Create the models
      const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
      let { model, model32k } = createModels(projectName);

      const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 15000 });
      const docs = await textSplitter.createDocuments([text]);

      let anonymize_prompt = new PromptTemplate({
        inputVariables: ["text"],
        template: `The task is to anonymize the following medical document by replacing any personally identifiable information (PII) with [ANON-N], 
        where N is the count of characters that have been anonymized. 
        Only specific information that can directly lead to patient identification needs to be anonymized. This includes but is not limited to: 
        full names, addresses, contact details, Social Security Numbers, and any unique identification numbers. 
        However, it's essential to maintain all medical specifics, such as medical history, diagnosis, treatment plans, and lab results, as they are not classified as PII. 
        The anonymized document should retain the integrity of the original content, apart from the replaced PII. 
        Avoid including any information that wasn't part of the original document and ensure the output reflects the original content structure and intent, albeit anonymized. 
        Here is the original document between the triple quotes:
        ----------------------------------------
        """
        {text}
        """
        ----------------------------------------
        ANONYMIZED DOCUMENT:
        `,
        });
  
  

      // This function creates a document chain prompted to anonymize a set of documents.
      const chain = new LLMChain({
        llm: model32k,
        prompt: anonymize_prompt,          
      });

      const message = {"docId": doc_id, "status": "anonimizando documentos", "filename": filename, "step": "anonymize"}
      pubsub.sendToUser(userId, message)
      
      // Iterate over the documents and anonymize them, create a complete document with all the anonymized documents
      let anonymized_docs = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const res = await chain.call({
          text: doc.pageContent,
        });
        anonymized_docs.push(res.text);
      }
      const anonymized_text = anonymized_docs.join("\n\n");

      // Compare the anonymized text with the original text lengths
      const anonymized_text_length = anonymized_text.length;
      const original_text_length = text.length;
      const reduction = (original_text_length - anonymized_text_length) / original_text_length;
      
      // Create a blob with the summary
      const existFile = await azure_blobs.checkBlobExists(containerName,url2);
      console.log("Exist file: ", existFile);
      if(existFile){
        const blob_response = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/anonymized_translated.txt'), anonymized_text)
        // Do an Inverse Translation
        // Check if the doc_lang is available in DeepL
        deepl_code = await translate.getDeeplCode(doc_lang);
        if (deepl_code == null) {
          // Do an Inverse Translation
          const info = [{ "Text": anonymized_text }];
          const inverseTranslatedText = await translate.getTranslationDictionaryInvertMicrosoft2(info, doc_lang);
          source_text = inverseTranslatedText[0].translations[0].text
        } else {
          // Do a Translation
          source_text = await translate.deepLtranslate(anonymized_text, deepl_code);
        }
        const blob_response2 = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/anonymized.txt'), source_text)
      }
      
      // Alert the client that the summary is ready (change status in the message)
      message.status = "anonymize ready"
      pubsub.sendToUser(userId, message)
      resolve(true);
    } catch (error) {
      console.log("Error happened: ", error)
      insights.error(error);
      pubsub.sendToUser(userId, {"docId": doc_id, "status": "error anonymize", "filename": filename, "error": error, "step": "anonymize"})
      resolve(false);
    };
  });
}


async function summarizePatient(patientId, userId) {
  return new Promise(async (resolve, reject) => {
  try {
    const message = {"status": "patient card started", "step": "summary"}
    pubsub.sendToUser(userId, message)

    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { model, model32k} = createModels(projectName);

    // Decrypt the patientId
    const patientIdEncrypted = crypt.encrypt(patientId);
    const containerName = patientIdEncrypted.substr(1)
    // Get all the summaries for this patient
    // List all blobs from the patient folder
    const blobs = await azure_blobs.listContainerFiles(containerName);
    // Filter the summaries
    const summary_translated_blobs = blobs.filter(blob => blob.endsWith("summary_translated.txt"));
    // Download the summaries
    const summaries = await Promise.all(summary_translated_blobs.map(blob => azure_blobs.downloadBlob(containerName, blob)));

    // Create a langchain prompt with all the summaries to generate a summary
    let summarize_summaries_prompt = new PromptTemplate({
      inputVariables: ["summaries"],
      template: `Please summarize all the summaries for this patient.
      Include the date, type of event, and any relevant details. This is the list of summaries:
      ${"```"}{summaries}${"```"}

      ---
      SUMMARY:
      `,
    });

    const chainSummaries = new LLMChain({
      llm: model,
      prompt: summarize_summaries_prompt,          
    });

    const summarizedSummaries = await chainSummaries.call({
      summaries: summaries.join("\n\n"),
    });

    // Get all the verified events for this patient
    // Controler de events
    const events = await getActualEvents(patientId);
    
    // Filter the verified events
    const verifiedEvents = events.filter(event => event.checked === true);

    // Count the amount of each type of verified event
    const eventCounts = verifiedEvents.reduce((counts, event) => {
      const eventType = event.type;
      counts[eventType] = (counts[eventType] || 0) + 1;
      return counts;
    }, {});

    // Generate the event summary
    let event_summary = "";
    for (const eventType in eventCounts) {
      const count = eventCounts[eventType];
      event_summary += `${count} ${eventType}, :\n`;
      // add a list of the events of this type (name, date)
      const eventsOfType = verifiedEvents.filter(event => event.type === eventType);
      for (const event of eventsOfType) {
        const formattedDate = event.date ? new Date(event.date).toDateString() : "unknown";
        event_summary += `  ${event.name} (${formattedDate})\n`;
      }
    }

    // Create a langchain prompt with all the verified events to generate a summary
    let summarize_events_prompt = new PromptTemplate({
      inputVariables: ["event_summary"],
      template: `Please summarize all the verified events for this patient. 
      Include the date, type of event, and any relevant details. This is the list of verified events:
      ${"```"}{event_summary}${"```"}

      ---
      SUMMARY:
      `,
    });

    const chainEvents = new LLMChain({
      llm: model,
      prompt: summarize_events_prompt,          
    });

    const summarizedEvents = await chainEvents.call({
      event_summary: event_summary,
    });

    // Create a langchain prompt with the summaries of the summaries and the event summary to generate a summary
    let final_card_summary_prompt = new PromptTemplate({
      inputVariables: ["summarizedSummaries", "summarizedEvents"],
      template: `Please summarize the patient document summaries and the verified events for this patient.
      I'm providing the summaries and the verified events for you to use as a reference:
      Here are the doc summaries summarized:
      ${"```"}{summarizedSummaries}${"```"}
      Here are the verified events summarized:
      ${"```"}{summarizedEvents}${"```"}
    
      I want you to create a card of presentation of this patient for the doctor.
      Therefore take all the information you have and create a summary of the patient in a card format.
      With this card the doctor should be able to understand the patient's situation and history.
      The card should be in the following format:
      ---
      CARD SUMMARY for the PATIENT:
      Don't output anything more than the following JSON. Even if you don't have all the information, you should output ONLY the JSON with all the keys but the values can be empty if you don't have the information.
      Please provide your response in the form of a JSON object with the following keys (if present):
      - 'Name'
      - 'Age', string
      - 'Gender'
      - 'CurrentStatus'
      - 'Diagnoses', which should be an array if present.
      - 'Medication', which should be an array if present.
      - 'Treatments', which should be an array if present.
      - 'LaboratoryFindings', which should be an array if present.
      - 'AdditionalInformation', which should be an array if present.
      `,
    });
    

    const chainFinalCardSummary = new LLMChain({
      llm: model,
      prompt: final_card_summary_prompt,
    });

    const finalCardSummary = await chainFinalCardSummary.call({
      summarizedSummaries: summarizedSummaries.text,
      summarizedEvents: summarizedEvents.text,
    });

    // console.log(finalCardSummary.text);

    // Get the most common language of the original documents (download from blob)
    const mostCommonLanguage = await getMostCommonLanguage(blobs, containerName);
    
    // Extract JSON from the string
    let match = finalCardSummary.text.match(/\{(.|\n)*\}/);
    // Create a blob with the final card summary
    const blob_response = await azure_blobs.createBlob(containerName, 'raitofile/summary/final_card_translated.txt', match[0]);

    // Parse the summary into JSON
    let summaryJson, jsonString;

    if (match) {
      jsonString = match[0];
      try {
        summaryJson = JSON.parse(jsonString);
        // Rest of the code...
      } catch (error) {
        console.error('Failed to parse JSON:', jsonString);
      }
    } else {
      console.error('No JSON object found in the string');
    }
    
    // Check if the doc_lang is available in DeepL
    deepl_code = await translate.getDeeplCode(mostCommonLanguage);
    
    // Function to translate text
    async function translateText(text, deepl_code) {
      // Don't try to translate if text is empty or an empty array
      if (!text || (Array.isArray(text) && text.length === 0)) {
        return text;
      }
      if (deepl_code == null) {
        // Do an Inverse Translation
        const info = [{ "Text": text }];
        const inverseTranslatedText = await translate.getTranslationDictionaryInvertMicrosoft2(info, mostCommonLanguage);
        return inverseTranslatedText[0].translations[0].text;
      } else {
        // Do a Translation
        return await translate.deepLtranslate(text, deepl_code);
      }
    }

    // Loop through the JSON and translate the values
    for (let key in summaryJson) {
      if(Array.isArray(summaryJson[key])) {
        // Translate each item in the array
        for(let i = 0; i < summaryJson[key].length; i++) {
          summaryJson[key][i] = await translateText(summaryJson[key][i], deepl_code);
        }
      } else {
        // Translate the string
        summaryJson[key] = await translateText(summaryJson[key], deepl_code);
      }
    }
    
    // Reassemble the translated JSON into a string
    const translatedSummary = JSON.stringify(summaryJson);

    const blob_response2 = await azure_blobs.createBlob(containerName, 'raitofile/summary/final_card.txt', translatedSummary)
    // Alert the client that the final card is ready (change status in the message)
    message.status = "patient card ready"
    pubsub.sendToUser(userId, message)
    resolve(true);
  } catch (error) {
    insights.error(error);
    console.error(error);
    const message = {"status": "patient card fail", "step": "summary"}
    pubsub.sendToUser(userId, message)
    reject(error);
  }
});
}



module.exports = {
  summarize,
  clean_and_extract,
  anonymize,
  summarizePatient
};