import { BaseStore, LangGraphRunnableConfig } from "@langchain/langgraph";

/**
 * Get the store from the configuration or throw an error.
 */
export function getStoreFromConfigOrThrow(
  config: LangGraphRunnableConfig
): BaseStore {
  if (!config.store) {
    throw new Error("Store not found in configuration");
  }

  return config.store;
}

/**
 * Split the fully specified model name into model and provider.
 */
export function splitModelAndProvider(fullySpecifiedName: string): {
  model: string;
  provider?: string;
} {
  if (fullySpecifiedName.includes("/")) {
    const [provider, model = ""] = fullySpecifiedName.split("/", 2);
    return { model, provider };
  }

  return { model: fullySpecifiedName };
}
