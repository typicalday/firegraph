import { addressSchema } from '../../shared/address.js';

export default {
  type: 'object',
  required: ['title', 'location'],
  properties: {
    title: { type: 'string', minLength: 1 },
    capacity: { type: 'integer', minimum: 1 },
    location: addressSchema,
  },
  additionalProperties: false,
};
