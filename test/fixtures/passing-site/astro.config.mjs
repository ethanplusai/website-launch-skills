import sitemap from '@astrojs/sitemap'

export default {
  site: 'https://passing.test',
  trailingSlash: 'never',
  integrations: [sitemap()],
}
