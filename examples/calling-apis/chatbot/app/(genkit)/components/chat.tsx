"use client";
import { useQueryState } from "nuqs";
import { FormEventHandler, useEffect, useRef, useState } from "react";

import { TokenVaultConsentPopup } from "@/components/auth0-ai/TokenVault/popup";
import { TokenVaultInterrupt } from "@auth0/ai/interrupts";

const useFocus = () => {
  const htmlElRef = useRef<HTMLInputElement>(null);
  const setFocus = () => {
    if (!htmlElRef.current) {
      return;
    }
    htmlElRef.current.focus();
  };
  return [htmlElRef, setFocus] as const;
};

export default function Chat() {
  const [threadId, setThreadId] = useQueryState("threadId");
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<
    {
      role: "user" | "model";
      content: [{ text?: string; metadata?: { interrupt?: any } }];
    }[]
  >([]);

  useEffect(() => {
    if (!threadId) {
      setThreadId(self.crypto.randomUUID());
    }
  }, [threadId, setThreadId]);

  useEffect(() => {
    if (!threadId) {
      return;
    }

    setIsLoading(true);

    (async () => {
      const messagesResponse = await fetch(`/api/genkit/chat/${threadId}`, {
        method: "GET",
        credentials: "include",
      });
      if (!messagesResponse.ok) {
        setMessages([]);
      } else {
        setMessages(await messagesResponse.json());
      }
      setIsLoading(false);
    })();
  }, [threadId]);

  const [inputRef, setInputFocus] = useFocus();
  useEffect(() => {
    if (isLoading) {
      return;
    }
    setInputFocus();
  }, [isLoading, setInputFocus]);

  const submit = async ({
    message,
    interruptedToolRequest,
  }: {
    message?: string;
    interruptedToolRequest?: any;
  }) => {
    setIsLoading(true);
    const timezone = {
      region: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date().getTimezoneOffset(),
    };
    const response = await fetch(`/api/genkit/chat/${threadId}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, interruptedToolRequest, timezone }),
    });
    if (!response.ok) {
      console.error("Error sending message");
    } else {
      const { messages: messagesResponse } = await response.json();
      setMessages(messagesResponse);
    }
    setIsLoading(false);
  };

  // //When the user submits a message, add it to the list of messages and resume the conversation.
  const handleSubmit: FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setMessages((messages) => [
      ...messages,
      { role: "user", content: [{ text: input }] },
    ]);
    submit({ message: input });
    setInput("");
  };

  return (
    <div className="flex flex-col gap-4 w-full max-w-md py-12 sm:py-24 px-4 sm:px-0 mx-auto stretch">
      {messages
        .filter(
          (m) =>
            ["model", "user", "tool"].includes(m.role) &&
            m.content?.length > 0 &&
            (m.content[0].text || m.content[0].metadata?.interrupt)
        )
        .map((message, index) => (
          <div key={index} className="whitespace-pre-wrap">
            {message.role === "user" ? "User: " : "AI: "}
            {message.content[0].text || ""}
            {!isLoading &&
            message.content[0].metadata?.interrupt &&
            TokenVaultInterrupt.isInterrupt(
              message.content[0].metadata?.interrupt
            )
              ? (() => {
                  const interrupt: any = message.content[0].metadata?.interrupt;
                  return (
                    <TokenVaultConsentPopup
                      onFinish={() =>
                        submit({ interruptedToolRequest: message.content[0] })
                      }
                      interrupt={interrupt}
                      connectWidget={{
                        title: `Requested by: "${interrupt.toolCall.toolName}"`,
                        description: "Description...",
                        action: { label: "Check" },
                      }}
                    />
                  );
                })()
              : null}
          </div>
        ))}

      <form onSubmit={handleSubmit}>
        <input
          className="fixed dark:bg-zinc-900 bg-white bottom-0 w-full max-w-sm sm:max-w-md p-3 mb-8 border border-zinc-300 dark:border-zinc-800 rounded-lg shadow-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
          value={input}
          ref={inputRef}
          placeholder="Say something..."
          readOnly={isLoading}
          disabled={isLoading}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
      </form>
    </div>
  );
}
