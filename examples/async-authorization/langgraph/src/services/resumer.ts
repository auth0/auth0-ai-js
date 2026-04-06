import { GraphResumer } from "@auth0/ai-langchain";
import { Client } from "@langchain/langgraph-sdk";

const resumer = new GraphResumer({
  langGraph: new Client({
    apiUrl: process.env.LANGGRAPH_API_URL || "http://localhost:54367",
  }),
  filters: { graphID: "conditional-trade" },
});

resumer
  .on("resume", async (thread) => {
    console.log(
      `attempting to resume ${thread.id} interrupted with ${thread.interruptionID}`
    );
  })
  .on("error", (err: Error) => {
    console.error(`Error in GraphResumer: ${err.message}`);
  });

export const main = async () => {
  resumer.start();
  console.log("Started Async Authorization Graph Poller");
  console.log(
    "The purpose of this service is to monitor interrupted threads by Async Authorization and resume them."
  );
};

main().catch(console.error);
