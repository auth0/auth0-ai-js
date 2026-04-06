/**
 * This could be replaced by LangGraph Cron Jobs in production
 * https://langchain-ai.github.io/langgraph/cloud/how-tos/cron_jobs/
 */
import { ScheduledRunCreateType } from "./ScheduledRunType";

export function SchedulerClient(url?: string) {
  return {
    schedule: async (data: ScheduledRunCreateType) => {
      try {
        // TODO: add authentication
        await fetch(url || `http://localhost:5555/schedule`, {
          method: "POST",
          body: JSON.stringify(data),
          headers: {
            "Content-Type": "application/json",
          },
        });
      } catch (e) {
        console.log(e);
      }
    },
    stop: async (taskId: string) => {
      try {
        // TODO: add authentication
        await fetch(url || `http://localhost:5555/schedule/${taskId}`, {
          method: "DELETE",
        });
      } catch (e) {
        console.log(e);
      }
    },
  };
}
