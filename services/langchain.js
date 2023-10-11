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
const { ConversationChain } = require("langchain/chains");
const { ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate, MessagesPlaceholder } = require("langchain/prompts");
const { BufferMemory } = require("langchain/memory");

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


// This function will be a basic conversation with documents (context)
// This will take some history of the conversation if any and the current documents if any
// And will return a proper answer to the question based on the conversation and the documents 
async function navigator_summarize(userId, question, conversation, context){
  try {
    // Create the models
    const projectName = `LITE - ${config.LANGSMITH_PROJECT} - ${userId}`;
    let { model, model32k, claude2 } = createModels(projectName);

    // Format and call the prompt
    let cleanPatientInfo = "";
    let i = 1;
    for (const doc of context) {
      cleanPatientInfo += "<Complete Document " + i + ">\n" + doc + "</Complete Document " + i + ">\n";
      i++;
    }

    const systemMessagePrompt = SystemMessagePromptTemplate.fromTemplate(
      `This is part of the medical information of the patient:

      ${cleanPatientInfo}

      You are a medical expert, based on this context with the condensed documents from the patient.`
    );

    const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate(
      `Take a deep breath and work on this problem step-by-step.      
      Please, answer the following question without making up any information:

      <input>
      {input}
      </input>
      
      If you don't find the answer or you need more information, please, return that you don't know the answer and ask for more information.`
    );

    const chatPrompt = ChatPromptTemplate.fromMessages([systemMessagePrompt, new MessagesPlaceholder("history"), humanMessagePrompt]);
    
    let memory;
    if (conversation === null) {
      memory = new BufferMemory({ returnMessages: true, memoryKey: "history" });
    } else {
      memory = new BufferMemory({ returnMessages: true, memoryKey: "history" });
      // Add the conversation history to the memory
      for (const message of conversation) {
        memory.addMessage(message);
      }
    }

    const chain = new ConversationChain({
      memory: memory,
      prompt: chatPrompt,
      llm: claude2,
    });
    
    const response = await chain.call({
      input: question,
    });

    console.log(response);
  } catch (error) {
    console.log("Error happened: ", error)
    insights.error(error);
  }
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

module.exports = {
  navigator_summarize,
  clean_and_extract,
  anonymize,
};