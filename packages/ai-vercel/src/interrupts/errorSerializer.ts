import { Auth0Interrupt } from "@auth0/ai/interrupts";

export type errorHandler = (error: unknown) => string;

export const InterruptionPrefix = "AUTH0_AI_INTERRUPTION:";

/**
 *
 * vercel-ai expects the error to be serialized as string in DataStreams.
 *
 * This function serializes the error to an string with the special prefix 'AUTH0_AI_INTERRUPTION:'.
 *
 * @param errHandler - error handler
 * @returns
 */
export const errorSerializer = (errHandler?: errorHandler): errorHandler => {
  return (error: any) => {
    if (
      !(error.cause instanceof Auth0Interrupt)
    ) {
      if (errHandler) {
        return errHandler(error);
      } else {
        return "An error occurred.";
      }
    }

    const serializableError = {
      ...error.cause.toJSON(),
      toolCall: {
        id: error.toolCallId,
        args: error.toolArgs,
        name: error.toolName,
      },
    };

    const result = `${InterruptionPrefix}${JSON.stringify(serializableError)}`;
    return result;
  };
};
