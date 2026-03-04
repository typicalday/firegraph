import { addressSchema } from '../../shared/address.js';

export default {
  type: 'object',
  required: ['name', 'venue'],
  properties: {
    name: { type: 'string', minLength: 1 },
    venue: addressSchema,
  },
  additionalProperties: false,
};
