## Authorization for Tools with Auth0 FGA/OpenFGA

Authorization for Tools ensures that users can only execute actions they are permitted to perform or access resources they are authorized to view. These examples demonstrate how to integrate **Auth0 FGA/OpenFGA** with **LangChain**, **LlamaIndex**, **Genkit** and others to enforce authorization checks during AI Tool executions.

### How It Works

1. **User Query**: A user submits a query requiring the execution of a tool.
2. **Authorization Check**: Auth0 FGA verifies the user's permissions, erroring when the user is not authorized to execute certain action.
3. **Response Generation**: The system generates a response tailored to the user's access level.

### Examples

Explore the following examples demonstrating the integration of **Auth0 FGA/OpenFGA** with **LangChain**, **LlamaIndex**, and **Genkit**:

- **LangChain with FGA Tool protection:**  
   An implementation showcasing how integrate `@auth0/ai` with LangChain to enforce authorization checks during tool execution.  
   [View Example](/examples/authorization-for-tools/langchain/)

- **LlamaIndex with FGA Tool protection:**  
   An implementation showcasing how integrate `@auth0/ai` with LlamaIndex to enforce authorization checks during tool execution.  
   [View Example](/examples/authorization-for-tools/llamaindex/)

- **Genkit with FGA Tool protection:**  
   An implementation showcasing how integrate `@auth0/ai` with Genkit to enforce authorization checks during tool execution.  
  [View Example](/examples/authorization-for-tools/genkit/)

- **AI SDK with FGA Tool protection:**  
   An implementation showcasing how integrate `@auth0/ai` with AI SDK to enforce authorization checks during tool execution.  
  [View Example](/examples/authorization-for-tools/ai-sdk/)
