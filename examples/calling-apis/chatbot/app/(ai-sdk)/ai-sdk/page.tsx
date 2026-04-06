import { ChevronLeft } from "lucide-react";
import Link from "next/link";

import Chat from "@/app/(ai-sdk)/components/chat";
import UserButton from "@/components/auth0/user-button";
import { auth0 } from "@/lib/auth0";

export default async function Home() {
  const session = await auth0.getSession();

  return (
    <div className="font-[family-name:var(--font-geist-sans)]">
      <header className="w-full max-w-7xl h-20 mx-auto flex items-center justify-between border-b border-gray-200 px-4 xl:px-0">
        <div className="flex flex-col gap-2">
          <Link href="/">
            <div className="text-muted-foreground flex gap-1 items-center text-sm">
              <ChevronLeft className="h-4 w-4 -ml-1" /> Back to Home
            </div>
          </Link>
          <div className="font-semibold text-xl">Auth0 AI | AI SDK Demo</div>
        </div>
        {session?.user && (
          <UserButton user={session.user} logoutUrl="/auth/logout" />
        )}
      </header>
      <main className="flex flex-col gap-8 row-start-2 items-center sm:items-start w-full">
        <Chat />
      </main>
    </div>
  );
}
