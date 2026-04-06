import { tool } from "llamaindex";
import { Octokit, RequestError } from "octokit";
import { z } from "zod/v3";

import { withGitHub } from "@/app/(llamaindex)/lib/auth0-ai";
import { getCredentialsFromTokenVault } from "@auth0/ai-vercel";
import { TokenVaultError } from "@auth0/ai/interrupts";

export const listRepositories = () =>
  withGitHub(
    tool(
      async () => {
        // Get the access token from Auth0 AI
        const credentials = getCredentialsFromTokenVault();

        // GitHub SDK
        try {
          const octokit = new Octokit({
            auth: credentials?.accessToken,
          });

          const { data } = await octokit.rest.repos.listForAuthenticatedUser();

          return data.map((repo) => repo.name);
        } catch (error) {
          if (error instanceof RequestError) {
            if (error.status === 401) {
              throw new TokenVaultError(
                `Authorization required to access the Token Vault`
              );
            }
          }

          throw error;
        }
      },
      {
        name: "listRepositories",
        description: "List repositories for the current user on GitHub",
        parameters: z.object({}),
      }
    )
  );
