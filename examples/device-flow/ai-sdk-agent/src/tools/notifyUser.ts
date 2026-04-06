import { tool } from "ai";
import { z } from "zod/v3";

import { mailer } from "../mail";

export const notifyUser = tool({
  description: "Notifies the user of a trade executed",
  inputSchema: z.object({
    email: z.string().describe("The email of the user to notify"),
    subject: z.string().describe("The subject of the email"),
    message: z.string().describe("The message of the email"),
  }),
  execute: async ({
    email,
    subject,
    message,
  }: {
    email: string;
    subject: string;
    message: string;
  }) => {
    await mailer.sendMail({
      to: email,
      subject,
      text: message,
    });
    return "Notification sent to the user.";
  },
});
