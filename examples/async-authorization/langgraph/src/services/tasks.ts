import { nanoid } from "nanoid";
import cron from "node-cron";
import storage, { Datum } from "node-persist";

import { Client } from "@langchain/langgraph-sdk";

import { ScheduledRunType } from "./ScheduledRunType";

const client = new Client({
  apiUrl: process.env.LANGGRAPH_API_URL || "http://localhost:54367",
});

export const tasks: { [key: string]: cron.ScheduledTask } = {};

export const addTask = async (task: ScheduledRunType) => {
  const taskId = nanoid();
  const taskWithTaskID: ScheduledRunType = {
    ...task,
    payload: {
      ...(task.payload ?? {}),
      config: {
        ...(task.payload?.config ?? {}),
        configurable: {
          ...(task.payload?.config?.configurable ?? {}),
          taskId,
        },
      },
    },
  };
  tasks[taskId] = cron.schedule(task.schedule!, async () => {
    return executeTask(taskId);
  });
  await storage.setItem(taskId, taskWithTaskID);
  return taskId;
};

export const stopTask = async (taskId: string) => {
  const task = tasks[taskId];
  if (task) {
    console.log(`Stopping task ${taskId}`);
    task.stop();
    delete tasks[taskId];
  }
  await storage.removeItem(taskId);
};

const executeTask = async (taskId: string) => {
  const task = (await storage.getItem(taskId)) as ScheduledRunType;
  let threadID = task.threadID;

  try {
    if (!threadID) {
      const threads = await client.threads.create();
      threadID = threads.thread_id;
      console.log(`new thread is created: ${threadID}`);
    }

    console.log(`Executing task ${taskId} | ${task.assistantID}`);
    await client.runs.wait(threadID, task.assistantID, task.payload);
    console.log(`Executed task ${taskId} | ${task.assistantID}`);
  } catch (err) {
    console.error(`Error executing task ${taskId} | ${task.assistantID}`);
    console.error(err);
    throw err;
  }
};

export const init = async () => {
  // Initialize stored tasks
  await storage.init({ dir: "./.scheduler" });

  const storedTasks = await storage.data();

  storedTasks.forEach((task: Datum) => {
    if (cron.validate(task.value.schedule)) {
      const scheduledTask = cron.schedule(task.value.schedule, () => {
        executeTask(task.key);
      });
      tasks[task.key] = scheduledTask;
    }
  });
};
