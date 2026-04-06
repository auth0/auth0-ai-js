"use client";

import { DefaultChatTransport, generateId } from "ai";
import { useState } from "react";

import { TokenVaultConsentPopup } from "@/components/auth0-ai/TokenVault/popup";
import { useChat } from "@ai-sdk/react";
import { useInterruptions } from "@auth0/ai-vercel/react";
import { TokenVaultInterrupt } from "@auth0/ai/interrupts";

export default function Chat() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, toolInterrupt } =
    useInterruptions((handler) =>
      useChat({
        transport: new DefaultChatTransport({ api: '/api/llamaindex' }),
        experimental_throttle: 100,
        generateId,
        onError: handler((error) => console.error("Chat error:", error))
      })
    );

    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      sendMessage({ text: input });
      setInput('');
    };

  return (
    <div className="flex flex-col gap-4 w-full max-w-md py-12 sm:py-24 px-4 sm:px-0 mx-auto stretch">
      {messages.map((message, index) => {
        const answer = message.role === "user" ? (message.parts[0] as any)?.text : message.parts && message.parts.length > 0 && (message.parts[0] as any)?.text?.match(/[\n\r]Answer:(.*?)[\n\r]/);
        const isInterrupt = TokenVaultInterrupt.isInterrupt(toolInterrupt);
        return (
          <div key={message.id} className="whitespace-pre-wrap">
            {message.role === "user" ? "User: " : "AI: "}
            {(isInterrupt && message.role === "assistant" && index === messages.length - 1) ? (
              <div className="flex flex-col gap-4">
              {TokenVaultInterrupt.isInterrupt(toolInterrupt) && (
                  <TokenVaultConsentPopup
                    onFinish={toolInterrupt.resume}
                    interrupt={toolInterrupt}
                    connectWidget={{
                      title: `Requested by: "${toolInterrupt.name}"`,
                      description: "Description...",
                      action: { label: "Check" },
                    }}
                  />
                )}
            </div>
          ) : answer ? message.role === "user" ? answer?.trim() : answer[1]?.trim() : null}
 
        </div>
        )
      })}

      <form onSubmit={handleSubmit}>
        <input
          className="fixed dark:bg-zinc-900 bg-white bottom-0 w-full max-w-sm sm:max-w-md p-3 mb-8 border border-zinc-300 dark:border-zinc-800 rounded-lg shadow-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
          value={input}
          placeholder="Say something..."
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
      </form>
    </div>
  );
}
