import type { BunPressConfig } from 'bunpress'

const config: BunPressConfig = {
  name: 'ts-cloud',
  description: 'Infrastructure as Code for TypeScript',
  url: 'https://ts-cloud.stacksjs.org',

  theme: {
    primaryColor: '#f97316',
  },

  sidebar: [
    {
      text: 'Introduction',
      link: '/',
    },
    {
      text: 'Guide',
      items: [
        { text: 'Getting Started', link: '/guide/getting-started' },
        { text: 'Cloud Providers', link: '/guide/providers' },
        { text: 'Deployment', link: '/guide/deployment' },
      ],
    },
    {
      text: 'Features',
      items: [
        { text: 'AWS Resources', link: '/features/aws' },
        { text: 'State Management', link: '/features/state' },
        { text: 'Multi-Region', link: '/features/multi-region' },
        { text: 'Environment Config', link: '/features/environments' },
      ],
    },
    {
      text: 'Advanced',
      items: [
        { text: 'Custom Providers', link: '/advanced/providers' },
        { text: 'Resource Dependencies', link: '/advanced/dependencies' },
        { text: 'Rollback Strategies', link: '/advanced/rollback' },
        { text: 'CI/CD Integration', link: '/advanced/cicd' },
      ],
    },
  ],

  navbar: [
    { text: 'Home', link: '/' },
    { text: 'Guide', link: '/guide/getting-started' },
    { text: 'GitHub', link: 'https://github.com/stacksjs/ts-cloud' },
  ],

  socialLinks: [
    { icon: 'github', link: 'https://github.com/stacksjs/ts-cloud' },
    { icon: 'discord', link: 'https://discord.gg/stacksjs' },
    { icon: 'twitter', link: 'https://twitter.com/stacksjs' },
  ],
}

export default config
