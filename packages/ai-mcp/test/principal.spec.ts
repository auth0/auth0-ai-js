import { describe, expect, it } from 'vitest';
import type { VerifiedAccessTokenClaims } from '@auth0/auth0-api-js';
import { buildPrincipal } from '../src/principal.js';
import { UnauthenticatedError } from '../src/errors.js';

function claims(overrides: Record<string, unknown>): VerifiedAccessTokenClaims {
  return overrides as unknown as VerifiedAccessTokenClaims;
}

const BASE = { sub: 'user|123', exp: 1_900_000_000 };

describe('buildPrincipal', () => {
  describe('sub', () => {
    it('copies a valid sub', () => {
      expect(buildPrincipal(claims(BASE)).sub).toBe('user|123');
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['blank', '   '],
      ['number', 42],
      ['object', { a: 1 }],
    ])('rejects a %s sub with a generic message', (_name, sub) => {
      const input = claims({ ...BASE, sub });
      expect(() => buildPrincipal(input)).toThrowError(UnauthenticatedError);
      expect(() => buildPrincipal(input)).toThrowError('Access token has a missing or blank subject.');
    });

    it('does not read sub from the prototype chain', () => {
      const input = Object.create({ sub: 'inherited' }, { exp: { value: BASE.exp, enumerable: true } });
      expect(() => buildPrincipal(input)).toThrowError(UnauthenticatedError);
    });

    it('does not leak claim values in the message', () => {
      const inputs = [
        claims({ sub: 'secret-sub-value', exp: 'secret-exp-value' }),
        claims({ sub: '   ', exp: 'secret-exp-value' }),
      ];
      for (const input of inputs) {
        let caught: unknown;
        try {
          buildPrincipal(input);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(UnauthenticatedError);
        expect((caught as UnauthenticatedError).statusCode).toBe(401);
        expect((caught as Error).message).not.toContain('secret-sub-value');
        expect((caught as Error).message).not.toContain('secret-exp-value');
      }
    });
  });

  describe('exp', () => {
    it('maps exp to expiresAt', () => {
      expect(buildPrincipal(claims(BASE)).expiresAt).toBe(BASE.exp);
    });

    it.each([
      ['missing', undefined],
      ['string', '1900000000'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['null', null],
    ])('rejects a %s exp with a generic message', (_name, exp) => {
      const input = claims({ sub: BASE.sub, exp });
      expect(() => buildPrincipal(input)).toThrowError(UnauthenticatedError);
      expect(() => buildPrincipal(input)).toThrowError('Access token has a missing or invalid expiry.');
    });
  });

  describe('exp (inheritance)', () => {
    it('does not read exp from the prototype chain', () => {
      const input = Object.create({ exp: 9999999999 });
      input.sub = 'user|123';
      expect(() => buildPrincipal(input)).toThrowError('Access token has a missing or invalid expiry.');
    });
  });

  describe('clientId', () => {
    it('uses client_id', () => {
      expect(buildPrincipal(claims({ ...BASE, client_id: 'cid' })).clientId).toBe('cid');
    });

    it('falls back to azp', () => {
      expect(buildPrincipal(claims({ ...BASE, azp: 'azp1' })).clientId).toBe('azp1');
    });

    it('prefers azp over client_id when both are present', () => {
      expect(buildPrincipal(claims({ ...BASE, client_id: 'cid', azp: 'azp1' })).clientId).toBe('azp1');
    });

    it('falls back to client_id when azp is empty or not a string', () => {
      expect(buildPrincipal(claims({ ...BASE, client_id: 'cid', azp: '' })).clientId).toBe('cid');
      expect(buildPrincipal(claims({ ...BASE, client_id: 'cid', azp: 7 })).clientId).toBe('cid');
    });

    it('accepts a token that carries neither azp nor client_id, with a null clientId', () => {
      expect(buildPrincipal(claims(BASE)).clientId).toBeNull();
    });

    it('is null when neither is a usable string', () => {
      expect(buildPrincipal(claims(BASE)).clientId).toBeNull();
      expect(buildPrincipal(claims({ ...BASE, client_id: '', azp: 5 })).clientId).toBeNull();
    });

    it('ignores client_id and azp on the prototype chain', () => {
      const input = Object.create({ client_id: 'inherited', azp: 'inherited' });
      Object.assign(input, BASE);
      expect(buildPrincipal(input).clientId).toBeNull();
    });
  });

  describe('orgId', () => {
    it('reads org_id', () => {
      expect(buildPrincipal(claims({ ...BASE, org_id: 'org_1' })).orgId).toBe('org_1');
    });

    it('is null when absent or empty', () => {
      expect(buildPrincipal(claims(BASE)).orgId).toBeNull();
      expect(buildPrincipal(claims({ ...BASE, org_id: '' })).orgId).toBeNull();
    });

    it.each([['a number', 9], ['null', null], ['an object', { id: 'org_1' }], ['an array', ['org_1']]])(
      'rejects an org_id that is %s',
      (_label, value) => {
        expect(() => buildPrincipal(claims({ ...BASE, org_id: value }))).toThrow(UnauthenticatedError);
      }
    );

    it('ignores org_id on the prototype chain', () => {
      const input = Object.create({ org_id: 'org_inherited' });
      Object.assign(input, BASE);
      expect(buildPrincipal(input).orgId).toBeNull();
    });
  });

  describe('scopes', () => {
    it('splits on any whitespace and drops empties', () => {
      const p = buildPrincipal(claims({ ...BASE, scope: ' read:a  write:b\tadmin\n' }));
      expect(p.scopes).toEqual(['read:a', 'write:b', 'admin']);
    });

    it('is empty when absent, empty or not a string', () => {
      expect(buildPrincipal(claims(BASE)).scopes).toEqual([]);
      expect(buildPrincipal(claims({ ...BASE, scope: '' })).scopes).toEqual([]);
      expect(buildPrincipal(claims({ ...BASE, scope: ['a'] })).scopes).toEqual([]);
    });

    it('does not derive scopes from permissions', () => {
      expect(buildPrincipal(claims({ ...BASE, permissions: ['read:a'] })).scopes).toEqual([]);
    });

    it('ignores scope on the prototype chain', () => {
      const input = Object.create({ scope: 'admin' });
      Object.assign(input, BASE);
      expect(buildPrincipal(input).scopes).toEqual([]);
    });
  });

  describe('permissions', () => {
    it('is null when the claim is absent', () => {
      expect(buildPrincipal(claims(BASE)).permissions).toBeNull();
    });

    it('returns a copy of a present array', () => {
      const source = ['read:a', 'write:b'];
      const p = buildPrincipal(claims({ ...BASE, permissions: source }));
      expect(p.permissions).toEqual(source);
      expect(p.permissions).not.toBe(source);
    });

    it('keeps an empty array as empty, not null', () => {
      expect(buildPrincipal(claims({ ...BASE, permissions: [] })).permissions).toEqual([]);
    });

    it.each([['a string', 'read:a'], ['null', null], ['an object', { a: 1 }]])(
      'rejects a permissions claim that is %s',
      (_label, value) => {
        expect(() => buildPrincipal(claims({ ...BASE, permissions: value }))).toThrow(UnauthenticatedError);
      }
    );

    it('rejects a permissions array with a non-string entry', () => {
      expect(() => buildPrincipal(claims({ ...BASE, permissions: ['read:a', 1] }))).toThrow(UnauthenticatedError);
      expect(() => buildPrincipal(claims({ ...BASE, permissions: ['read:a', null] }))).toThrow(UnauthenticatedError);
    });

    it('keeps an empty permissions array as no permissions', () => {
      expect(buildPrincipal(claims({ ...BASE, permissions: [] })).permissions).toEqual([]);
    });

    it('ignores permissions on the prototype chain', () => {
      const input = Object.create({ permissions: ['admin'] });
      Object.assign(input, BASE);
      expect(buildPrincipal(input).permissions).toBeNull();
    });
  });

  describe('immutability', () => {
    it('is frozen when permissions is absent', () => {
      const p = buildPrincipal(claims(BASE));
      expect(p.permissions).toBeNull();
      expect(Object.isFrozen(p)).toBe(true);
    });

    it('is unaffected by later mutation of the input claims', () => {
      const input: Record<string, unknown> = { ...BASE, scope: 'a b', permissions: ['p'], org_id: 'org_1' };
      const p = buildPrincipal(claims(input));
      input['sub'] = 'other';
      input['scope'] = 'z';
      input['org_id'] = 'org_2';
      (input['permissions'] as string[]).push('x');
      expect(p).toEqual({
        sub: 'user|123',
        expiresAt: BASE.exp,
        scopes: ['a', 'b'],
        permissions: ['p'],
        clientId: null,
        orgId: 'org_1',
      });
    });

    it('returns a frozen principal with frozen arrays', () => {
      const p = buildPrincipal(claims({ ...BASE, scope: 'a', permissions: ['p'] }));
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.scopes)).toBe(true);
      expect(Object.isFrozen(p.permissions)).toBe(true);
    });
  });
});
