// The one file edited when a site is stood up from the starter. Every value below is a stand-in.

export const site = {
  name: 'Example Practice',
  origin: 'https://example.com',
  domain: 'example.com',

  // Each client gets its own bucket; the key prefix is the bare domain.
  r2: {
    publicBase: 'REPLACE_WITH_THIS_SITES_BUCKET_URL',
    prefix: 'example.com',
  },

  // Forms post to `${formsBase}/api/submit/{formId}`; paste each form's id here.
  formsBase: 'https://forms.starter.test',
  forms: {
    contact: 'REPLACE_WITH_FORM_ID',
  } as Record<string, string>,
} as const
