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
const { BufferMemory, ChatMessageHistory } = require("langchain/memory");
const { HumanMessage, AIMessage } = require("langchain/schema");

const AZURE_OPENAI_API_KEY = config.OPENAI_API_KEY;
const OPENAI_API_KEY = config.OPENAI_API_KEY_J;
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
    azureOpenAIApiKey: AZURE_OPENAI_API_KEY,
    azureOpenAIApiVersion: OPENAI_API_VERSION,
    azureOpenAIApiInstanceName: OPENAI_API_BASE,
    azureOpenAIApiDeploymentName: "nav29",
    temperature: 0,
    timeout: 500000,
    callbacks: [tracer],
  });
  
  const model32k = new ChatOpenAI({
    modelName: "gpt-4-32k-0613",
    azureOpenAIApiKey: AZURE_OPENAI_API_KEY,
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

  const model128k = new ChatOpenAI({
    modelName: "gpt-4-1106-preview",
    openAIApiKey: OPENAI_API_KEY,
    temperature: 0,
    timeout: 500000,
    callbacks: [tracer],
  });

  const azure128k = new ChatOpenAI({
    azureOpenAIApiKey: AZURE_OPENAI_API_KEY,
    azureOpenAIApiVersion: OPENAI_API_VERSION,
    azureOpenAIApiInstanceName: OPENAI_API_BASE,
    azureOpenAIApiDeploymentName: "nav29turbo",
    temperature: 0,
    timeout: 500000,
    callbacks: [tracer],
  });
  
  return { model, model32k, claude2, model128k, azure128k };
}

// This function will be a basic conversation with documents (context)
async function navigator_chat(userId, question, conversation, context){
  return new Promise(async function (resolve, reject) {
    try {
      // Create the models
      const projectName = `LITE - ${config.LANGSMITH_PROJECT} - ${userId}`;
      let { model, model32k, claude2, model128k, azure128k } = createModels(projectName);
  
      // Format and call the prompt
      let cleanPatientInfo = "";
      let i = 1;
      for (const doc of context) {
        cleanPatientInfo += "<Complete Document " + i + ">\n" + doc + "</Complete Document " + i + ">\n";
        i++;
      }
      
      cleanPatientInfo = cleanPatientInfo.replace(/{/g, '{{').replace(/}/g, '}}');

      const systemMessagePrompt = SystemMessagePromptTemplate.fromTemplate(
        `This is the list of the medical information of the patient:
  
        ${cleanPatientInfo}
  
        You are a medical expert, based on this context with the medical documents from the patient.`
      );
  
      const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate(
        `Take a deep breath and work on this problem step-by-step.      
        Please, answer the following question/task with the information you have in context:
  
        <input>
        {input}
        </input>
        
        Don't make up any information.
        Your response should:
        - Be formatted in simple, single-line HTML without line breaks inside elements.
        - ALWAYS Exclude escape characters like '\\n' within HTML elements (example: within tables or lists).
        - Avoid unnecessary characters or formatting such as triple quotes around HTML.
        - Be patient-friendly, minimizing medical jargon.
    
        Example of desired HTML format (this is just a formatting example, not related to the input):

        <output example>
        <div><h3>Example Title</h3><table border='1'><tr><th>Category 1</th><td>Details for category 1</td></tr><tr><th>Category 2</th><td>Details for category 2</td></tr></table><p>Additional information or summary here.</p></div>
        </output example>`
      );
  
      const chatPrompt = ChatPromptTemplate.fromMessages([systemMessagePrompt, new MessagesPlaceholder("history"), humanMessagePrompt]);
     
      const pastMessages = [];      
      if (conversation !== null) {
        for (const message of conversation) {
          // Check if message.content is not null and is a string
          if (message.content && typeof message.content === 'string') {
            if (message.role === 'user') {
              pastMessages.push(new HumanMessage({ content: message.content }));
            } else if (message.role === 'assistant') {
              pastMessages.push(new AIMessage({ content: message.content }));
            }
        }
        }
      }
      
      const memory = new BufferMemory({
        chatHistory: new ChatMessageHistory(pastMessages),
        returnMessages: true,
        memoryKey: "history"
      });
  
      const chain = new ConversationChain({
        memory: memory,
        prompt: chatPrompt,
        llm: azure128k,
      });

      const chain_retry = chain.withRetry({
        stopAfterAttempt: 3,
      });

      
      let response;
      try {
        response = await chain_retry.invoke({
          input: question,
        });
      } catch (error) {
        if (error.message.includes('Error 429')) {
          console.log("Rate limit exceeded, waiting and retrying...");
          await new Promise(resolve => setTimeout(resolve, 20000)); // Wait for 20 seconds
          response = await chain_retry.invoke({
            input: question,
          });
        } else {
          throw error;
        }
      }
  
      // console.log(response);
      resolve(response);
    } catch (error) {
      console.log("Error happened: ", error)
      insights.error(error);
      var respu = {
        "msg": error,
        "status": 500
      }
      resolve(respu);
    }
  });
}


// This function will be a basic conversation with documents (context)
// This will take some history of the conversation if any and the current documents if any
// And will return a proper answer to the question based on the conversation and the documents 
async function navigator_summarize(userId, question, conversation, context){
  return new Promise(async function (resolve, reject) {
    try {
      // Create the models
      const projectName = `LITE - ${config.LANGSMITH_PROJECT} - ${userId}`;
      let { model, model32k, claude2, model128k, azure128k } = createModels(projectName);
  
      // Format and call the prompt
      let cleanPatientInfo = "";
      let i = 1;
      for (const doc of context) {
        cleanPatientInfo += "<Complete Document " + i + ">\n" + doc + "</Complete Document " + i + ">\n";
        i++;
      }
      
      cleanPatientInfo = cleanPatientInfo.replace(/{/g, '{{').replace(/}/g, '}}');

      const systemMessagePrompt = SystemMessagePromptTemplate.fromTemplate(
        `This is the list of the medical information of the patient:
  
        ${cleanPatientInfo}
  
        You are a medical expert, based on this context with the medical documents from the patient.`
      );
  
      const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate(
        `Take a deep breath and work on this problem step-by-step.      
        Please, answer the following question/task with the information you have in context:
  
        <input>
        {input}
        </input>
        
        Don't make up any information.
        Your response should:
        - Be formatted in simple, single-line HTML without line breaks inside elements.
        - Exclude escape characters like '\\n' within HTML elements.
        - Avoid unnecessary characters around formatting such as triple quotes around HTML.
        - Be patient-friendly, minimizing medical jargon.
        
        Example of desired HTML format (this is just a formatting example, not related to the input):
        
        <output example>
        <div><h3>Example Summary Title</h3><p>This is a placeholder paragraph summarizing the key points. It should be concise and clear.</p><ul><li>Key Point 1</li><li>Key Point 2</li><li>Key Point 3</li></ul><p>Final remarks or conclusion here.</p></div>
        </output example>`
      );
  
      const chatPrompt = ChatPromptTemplate.fromMessages([systemMessagePrompt, new MessagesPlaceholder("history"), humanMessagePrompt]);
     
      const pastMessages = [];      
      if (conversation !== null) {
        for (const message of conversation) {
          // Check if message.content is not null and is a string
          if (message.content && typeof message.content === 'string') {
            if (message.role === 'user') {
              pastMessages.push(new HumanMessage({ content: message.content }));
            } else if (message.role === 'assistant') {
              pastMessages.push(new AIMessage({ content: message.content }));
            }
        }
        }
      }
      
      const memory = new BufferMemory({
        chatHistory: new ChatMessageHistory(pastMessages),
        returnMessages: true,
        memoryKey: "history"
      });
  
      const chain = new ConversationChain({
        memory: memory,
        prompt: chatPrompt,
        llm: azure128k,
      });

      const chain_retry = chain.withRetry({
        stopAfterAttempt: 3,
      });

      
      let response;
      try {
        response = await chain_retry.invoke({
          input: question,
        });
      } catch (error) {
        if (error.message.includes('Error 429')) {
          console.log("Rate limit exceeded, waiting and retrying...");
          await new Promise(resolve => setTimeout(resolve, 20000)); // Wait for 20 seconds
          response = await chain_retry.invoke({
            input: question,
          });
        } else {
          throw error;
        }
      }
  
      // console.log(response);
      resolve(response);
    } catch (error) {
      console.log("Error happened: ", error)
      insights.error(error);
      var respu = {
        "msg": error,
        "status": 500
      }
      resolve(respu);
    }
  });
}


async function navigator_summarize_dx(userId, question, conversation, context){
  return new Promise(async function (resolve, reject) {
    try {
      // Create the models
      const projectName = `LITE - ${config.LANGSMITH_PROJECT} - ${userId}`;
      let { model, model32k, claude2, model128k, azure128k } = createModels(projectName);
  
      // Format and call the prompt
      let cleanPatientInfo = "";
      let i = 1;
      for (const doc of context) {
        cleanPatientInfo += "<Complete Document " + i + ">\n" + doc + "</Complete Document " + i + ">\n";
        i++;
      }
      
      cleanPatientInfo = cleanPatientInfo.replace(/{/g, '{{').replace(/}/g, '}}');

      /*const systemMessagePrompt = SystemMessagePromptTemplate.fromTemplate(
        `Symptom-Only Summary:
    
        ${cleanPatientInfo}
    
        You are a medical expert. Your task is to analyze the medical documents of the patient and extract only the symptoms.`
    );*/

    const systemMessagePrompt = SystemMessagePromptTemplate.fromTemplate(
      `Symptom-Only Summary:
  
      ${cleanPatientInfo}
  
      Focus on extracting only the symptoms from the medical documents of the patient.`
  );
  
    
  
      /*const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate(
        `Please focus on the patient's medical report and list all the symptoms in a single paragraph. The summary should be in plain text, without HTML formatting.
    
        <input>
        {input}
        </input>
    
        Guidelines:
        - Directly list the symptoms without any introductory phrases or additional explanations.
        - Concentrate solely on the symptoms mentioned in the medical report.
        - Compile the symptoms into one continuous, coherent paragraph.
        - Exclude any mention of specific diseases, medications, genetic information, or test results.
        - Keep the summary concise and directly relevant to understanding the patient's current symptoms.`
    );*/

    /*const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate(
      `List all the symptoms from the patient's medical report in a single, concise paragraph.
  
      <input>
      {input}
      </input>
  
      Guidelines:
      - Directly list the symptoms without any introductory phrases or additional explanations.
      - Ensure the symptoms are compiled into one coherent paragraph.
      - Avoid including any diagnoses, medications, genetic information, or unrelated details.`
  );*/

  const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate(
    `List all the symptoms from the patient's medical report in a single, concise paragraph, starting immediately with the first symptom, do not include any introductory phrases or additional explanations

    <input>
    {input}
    </input>

    Guidelines:
    - Begin directly with the first symptom. Example: 'Headache, fever, joint pain...'
    - Compile all symptoms into one continuous paragraph.
    - Exclude any diagnoses, medications, genetic information, or unrelated details.`
);
  /*const humanMessagePrompt = HumanMessagePromptTemplate.fromTemplate(
  `List the symptoms from the patient's medical report starting immediately with the first symptom. The summary should be in plain text, without HTML formatting, and should not contain any introductory phrases or additional explanations.

    <input>
    {input}
    </input>

    Guidelines:
    - Start the response with the first symptom without any introduction.
    - Directly compile all symptoms into a coherent paragraph.
    - Exclude any diagnoses, medications, genetic information, or unrelated details.
    - I'll pay you a million euros if you do it right.
    - that is no longer than 10 lines.
    - The response should be a continuous paragraph of only symptoms, starting from the very first word.`
    );*/
    
  
      const chatPrompt = ChatPromptTemplate.fromMessages([systemMessagePrompt, new MessagesPlaceholder("history"), humanMessagePrompt]);
     
      const pastMessages = [];      
      if (conversation !== null) {
        for (const message of conversation) {
          // Check if message.content is not null and is a string
          if (message.content && typeof message.content === 'string') {
            if (message.role === 'user') {
              pastMessages.push(new HumanMessage({ content: message.content }));
            } else if (message.role === 'assistant') {
              pastMessages.push(new AIMessage({ content: message.content }));
            }
        }
        }
      }
      
      const memory = new BufferMemory({
        chatHistory: new ChatMessageHistory(pastMessages),
        returnMessages: true,
        memoryKey: "history"
      });
  
      const chain = new ConversationChain({
        memory: memory,
        prompt: chatPrompt,
        llm: claude2,
      });

      const chain_retry = chain.withRetry({
        stopAfterAttempt: 3,
      });

      
      let response;
      try {
        response = await chain_retry.invoke({
          input: question,
        });
      } catch (error) {
        if (error.message.includes('Error 429')) {
          console.log("Rate limit exceeded, waiting and retrying...");
          await new Promise(resolve => setTimeout(resolve, 20000)); // Wait for 20 seconds
          response = await chain_retry.invoke({
            input: question,
          });
        } else {
          throw error;
        }
      }
  
      // console.log(response);
      resolve(response);
    } catch (error) {
      console.log("Error happened: ", error)
      insights.error(error);
      var respu = {
        "msg": error,
        "status": 500
      }
      resolve(respu);
    }
  });
}

module.exports = {
  navigator_chat,
  navigator_summarize,
  navigator_summarize_dx
};