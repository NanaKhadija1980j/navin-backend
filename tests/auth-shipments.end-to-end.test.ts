/** @see issue-#147 @see issue-#150 @see issue-#154 @see issue-#155 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import type { Application } from 'express';
import { seedAuthShipmentSuite, cleanupAuthShipmentSuite } from './helpers/authShipmentSuite.js';

describe('Issues #147, #150, #154, #155 - Combined signup and shipment flow', () => {
  let app: Application;
  let testOrgId: string;

  beforeAll(async () => {
    ({ app, testOrgId } = await seedAuthShipmentSuite());
  }, 120_000);

  afterAll(cleanupAuthShipmentSuite);

  describe('Combined functionality: All 4 issues working together', () => {
    it('should create shipment with auto-generated tracking number by admin user with auto-assigned role', async () => {
      // First, signup a new admin user (Issue #147)
      const signupRes = await request(app)
        .post('/api/auth/signup')
        .send({
          email: 'combined@navin.io',
          name: 'Combined Test Admin',
          password: 'password123',
          organizationId: testOrgId,
        });

      expect(signupRes.status).toBe(201);
      expect(signupRes.body.data.user.role).toBe('ADMIN');

      const newAdminToken = signupRes.body.data.token;

      // Now create a shipment without tracking number (Issues #154, #155)
      const shipmentRes = await request(app)
        .post('/api/shipments')
        .set('Authorization', `Bearer ${newAdminToken}`)
        .send({
          origin: 'Combined Test Origin',
          destination: 'Combined Test Destination',
          enterpriseId: testOrgId,
          logisticsId: testOrgId,
        });

      expect(shipmentRes.status).toBe(201);
      expect(shipmentRes.body.data.trackingNumber).toMatch(/^NVN-\d{6}$/);
    });

    it('should return proper 401 error structure when unauthorized user tries to create shipment', async () => {
      const res = await request(app)
        .post('/api/shipments')
        .send({
          origin: 'Test',
          destination: 'Test',
          enterpriseId: testOrgId,
          logisticsId: testOrgId,
        });

      // Issue #150: Standardized 401 response
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBe(null);
      expect(res.body.error.code).toBe('ERR_AUTH_INVALID');
    });
  });
});
