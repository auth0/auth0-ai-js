import "dotenv/config";

import Enquirer from "enquirer";

import { ai } from "./ai";
import { buyTool } from "./tools/buy";
import { weather } from "./tools/weather";

async function main() {
  try {
    console.log(`<Enter a command (type "exit" to quit)>\n\n`);

    const session = ai.createSession({});

    const chat = session.chat({ tools: [buyTool(ai), weather(ai)] });
    const enquirer = new Enquirer<{ message: string }>();

    while (true) {
      const { message } = await enquirer.prompt({
        type: "text",
        name: "message",
        message: "    ",
        prefix: "User",
      });

      if (message.toLowerCase() === "exit") {
        console.log("Goodbye!");
        break;
      }

      const { text } = await chat.send({
        prompt: message,
      });

      console.log(`Assistant · ${text}\n`);
    }
  } catch (error) {
    console.error(error);
    console.log("AGENT:error", error);
  }
}

main().catch((err) => console.error(err));
