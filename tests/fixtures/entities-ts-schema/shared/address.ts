/** Shared address schema fragment reused across entities. */
export const addressSchema = {
  type: 'object' as const,
  required: ['city', 'country'],
  properties: {
    street: { type: 'string' },
    city: { type: 'string', minLength: 1 },
    country: { type: 'string', minLength: 2, maxLength: 2 },
  },
  additionalProperties: false,
};
