import { expect, it } from 'vitest';
import { trustedWebPeer, validWebConfig, type WebConfig } from '../../../src/web/config';

const config: WebConfig = { version: 1, enabled: true, host: '127.0.0.1', additionalHosts: ['192.168.188.1'],
  port: 3345, secretHash: 'a'.repeat(64), trustedNetworks: ['192.168.188.0/24'] };

it.each(['127.0.0.1', '::ffff:127.0.0.1', '192.168.188.0', '192.168.188.1', '192.168.188.255', '::ffff:192.168.188.42'])('allows a trusted direct peer %s', ip => {
  expect(trustedWebPeer(config, ip)).toBe(true);
});
it.each(['192.168.187.255', '192.168.189.0', '10.88.80.121', '127.0.0.2', '::1', 'bad', undefined])('requires login outside the trusted source ranges: %s', ip => {
  expect(trustedWebPeer(config, ip)).toBe(false);
});
it('keeps old non-loopback listeners authenticated and matches a single-address CIDR exactly', () => {
  const old = { ...config, host: '192.168.188.1', additionalHosts: undefined, trustedNetworks: undefined };
  expect(trustedWebPeer(old, '127.0.0.1')).toBe(false); expect(trustedWebPeer(old, '192.168.188.1')).toBe(false);
  expect(trustedWebPeer({ ...old, trustedNetworks: ['192.168.188.42/32'] }, '192.168.188.42')).toBe(true);
  expect(trustedWebPeer({ ...old, trustedNetworks: ['192.168.188.42/32'] }, '192.168.188.43')).toBe(false);
});
it.each([
  { additionalHosts: ['0.0.0.0'] }, { additionalHosts: ['127.0.0.1'] }, { additionalHosts: ['bad'] },
  { trustedNetworks: ['192.168.188.0/33'] }, { trustedNetworks: ['192.168.188.0'] }, { trustedNetworks: ['192.168.999.0/24'] },
])('rejects invalid listener/trust configuration: %j', fields => {
  expect(validWebConfig(config)).toBe(true); expect(validWebConfig({ ...config, ...fields })).toBe(false);
});
