import bodyParser from "body-parser";
import express from "express";
import cron from "node-cron";

import { ScheduledRun } from "./ScheduledRunType";
import { addTask, init, stopTask } from "./tasks";

async function main() {
  const app = express();
  const port = 5555;

  await init();

  app.use(bodyParser.json());

  app.post("/schedule", async (req: express.Request, res: express.Response) => {
    const body = ScheduledRun.parse(req.body);
    const schedule = body.schedule || "*/5 * * * * *";
    if (!cron.validate(schedule)) {
      return res.status(400).json({ error: "Invalid cron expression" });
    }
    const id = await addTask(body);
    console.log(`Task scheduled: ${id}:${schedule}`);
    res.status(201).json({ id });
  });

  app.delete("/schedule/:id", async (req, res) => {
    const { id } = req.params;
    await stopTask(id);
    res.status(200).json({ id });
  });

  app.listen(port, () => {
    console.log(`Cron API service is running on http://localhost:${port}`);
  });
}

main().catch(console.error);
