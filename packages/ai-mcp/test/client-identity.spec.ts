import { describe, expect, it } from 'vitest';
import { ApiClient } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';

describe('McpClient domain and audience', () => {
  it('reports the domain and audience it was created with, unchanged', () => {
    const client = createMcpClient({ domain: 'Tenant.Example.com', audience: 'https://mcp.example.com/mcp' });
    expect(client.domain).toBe('Tenant.Example.com');
    expect(client.audience).toBe('https://mcp.example.com/mcp');
  });

  it('keeps a scheme-prefixed domain as given', () => {
    const client = createMcpClient({ domain: 'https://tenant.example.com/', audience: 'urn:acme:mcp' });
    expect(client.domain).toBe('https://tenant.example.com/');
    expect(client.audience).toBe('urn:acme:mcp');
  });

  it('reports the declared values next to a supplied apiClient', () => {
    const apiClient = new ApiClient({ domain: 'tenant.example.com', audience: 'https://mcp.example.com' });
    const client = createMcpClient({ domain: 'tenant.example.com', audience: 'https://mcp.example.com', apiClient });
    expect(client.domain).toBe('tenant.example.com');
    expect(client.audience).toBe('https://mcp.example.com');
  });

  it('reports undefined for a declared value that is not a usable string', () => {
    const apiClient = new ApiClient({ domain: 'tenant.example.com', audience: 'https://mcp.example.com' });
    const client = createMcpClient({
      domain: '  ',
      audience: undefined as unknown as string,
      apiClient,
    });
    expect(client.domain).toBeUndefined();
    expect(client.audience).toBeUndefined();
  });

  it('does not show up in the serialized or inspected view with a secret', () => {
    const client = createMcpClient({
      domain: 'tenant.example.com',
      audience: 'https://mcp.example.com',
      clientId: 'client',
      clientSecret: 'super-secret-value',
    });
    expect(JSON.stringify(client)).not.toContain('super-secret-value');
  });
});
