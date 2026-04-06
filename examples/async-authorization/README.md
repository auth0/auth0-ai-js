## Async Authorization

Async User Confirmation enables background agents to perform tasks that require user approval before completion. This ensures that important actions are executed only with the user's consent, enhancing security and user control. For more information, refer to the [documentation](https://demo.auth0.ai/docs/async-user-confirmation).

### How It Works

1. **User Request**: The user instructs the agent to monitor a specific condition, such as a stock's P/E ratio exceeding a certain value.
2. **Monitoring**: The agent continuously tracks the specified condition.
3. **Notification**: When the condition is met, the system notifies the user, requesting approval to proceed.
4. **User Approval**: The user reviews the request and provides consent if they choose to proceed.
5. **Action Execution**: Upon receiving user approval, the agent completes the requested action, such as purchasing stock shares.

This process ensures that users maintain control over significant actions initiated by automated agents.

### Diagram

Below is a high-level workflow:

<p align="center">
  <img
    style="margin-left: auto; margin-right: auto; padding: 10px; background: #4a4a4a; border-radius: 10px; max-height: 500px;"
    src="https://cdn.auth0.com/website/auth0-lab/ai/sdks/diagrams/async-user-confirmation-enroll.png"
  />
<p>

<p align="center">
  <img
    style="margin-left: auto; margin-right: auto; padding: 10px; background: #4a4a4a; border-radius: 10px; max-height: 500px;"
    src="https://cdn.auth0.com/website/auth0-lab/ai/sdks/diagrams/async-user-confirmation-authorize.png"
  />
<p>

### Examples

Explore the following examples demonstrating the integration of **Auth0's Async User confirmation** with **LangGraph**, **LlamaIndex**, **Genkit**, and others:

- **LangGraph:**  
  An implementation showcasing how to implement **Human in the Loop** using `@auth0/ai` with LangChain to enforce User Authorization Confirmation on tool executions.  
  [View Example](/examples/async-authorization/langgraph/)

- **LlamaIndex:**  
  An implementation showcasing how to implement **Human in the Loop** using `@auth0/ai` with LlamaIndex to enforce User Authorization Confirmation on tool executions.  
  [View Example](/examples/async-authorization/llamaindex/)

- **Genkit:**  
  An implementation showcasing how to implement **Human in the Loop** using `@auth0/ai` with Genkit to enforce User Authorization Confirmation on tool executions.  
  [View Example](/examples/async-authorization/genkit/)

- **AI SDK:**  
  An implementation showcasing how to implement **Human in the Loop** using `@auth0/ai` with AI SDK to enforce User Authorization Confirmation on tool executions.  
  [View Example](/examples/async-authorization/ai-sdk/)
