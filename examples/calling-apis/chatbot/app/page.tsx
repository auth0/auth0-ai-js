import { ChevronRight } from "lucide-react";
import Link from "next/link";

import UserButton from "@/components/auth0/user-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth0 } from "@/lib/auth0";

export default async function Home() {
  const session = await auth0.getSession();

  return (
    <div className="font-[family-name:var(--font-geist-sans)]">
      <header className="w-full max-w-7xl h-20 mx-auto flex items-center justify-between border-b border-gray-200 px-4 xl:px-0">
        <div className="font-semibold text-xl">Auth0 AI | Demo</div>
        {session?.user && (
          <UserButton user={session.user} logoutUrl="/auth/logout" />
        )}
      </header>
      <main className="flex flex-col gap-8 row-start-2 items-start md:items-center sm:items-start w-full">
        <div className="flex flex-col w-full max-w-md py-12 sm:py-24 px-4 sm:px-0 mx-auto stretch">
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Samples</CardTitle>
              <CardDescription>
                Learn how to call APIs on behalf of a user with Auth0 AI.
              </CardDescription>
            </CardHeader>

            <Link href="/ai-sdk">
              <CardContent className="grid gap-4">
                <div className="flex items-center space-x-4 rounded-md border p-4">
                  <div>
                    <img src="/vercel.svg" className="w-13 h-13" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-sm font-medium leading-none">AI SDK</p>
                    <p className="text-sm text-muted-foreground">
                      Integrate with{" "}
                      <span className="font-semibold">@auth0/ai-vercel</span>
                    </p>
                  </div>
                  <div className="text-muted-foreground">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </div>
              </CardContent>
            </Link>

            <Link href="/genkit">
              <CardContent className="grid gap-4">
                <div className="flex items-center space-x-4 rounded-md border p-4">
                  <div>
                    <img src="/genkit.svg" className="w-13 h-13" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-sm font-medium leading-none">GenKit</p>
                    <p className="text-sm text-muted-foreground">
                      Integrate with{" "}
                      <span className="font-semibold">@auth0/ai-genkit</span>
                    </p>
                  </div>
                  <div className="text-muted-foreground">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </div>
              </CardContent>
            </Link>

            <Link href="/langgraph">
              <CardContent className="grid gap-4">
                <div className="flex items-center space-x-4 rounded-md border p-4">
                  <div>
                    <img src="/langchain.svg" className="w-13 h-13" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-sm font-medium leading-none">
                      LangGraph
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Integrate with{" "}
                      <span className="font-semibold">@auth0/ai-langchain</span>
                    </p>
                  </div>
                  <div className="text-muted-foreground">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </div>
              </CardContent>
            </Link>

            <Link href="/llamaindex">
              <CardContent className="grid gap-4">
                <div className="flex items-center space-x-4 rounded-md border p-4">
                  <div>
                    <img src="/llamaindex.svg" className="w-13 h-13" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-sm font-medium leading-none">
                      LlamaIndex
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Integrate with{" "}
                      <span className="font-semibold">
                        @auth0/ai-llamaindex
                      </span>
                    </p>
                  </div>
                  <div className="text-muted-foreground">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </div>
              </CardContent>
            </Link>
          </Card>
        </div>
      </main>
    </div>
  );
}
