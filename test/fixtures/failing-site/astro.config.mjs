import sitemap from '@astrojs/sitemap'

export default {
  site: 'https://staging.example.com',
  trailingSlash: 'always',
  integrations: [sitemap()],
}
