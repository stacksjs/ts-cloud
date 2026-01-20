import type { BunPressConfig } from 'bunpress'

const config: BunPressConfig = {
  name: 'ts-cloud',
  description: 'Infrastructure as Code for TypeScript',
  url: 'https://ts-cloud.stacksjs.com',

  theme: 'vitepress',

  themeConfig: {
    colors: {
      primary: '#f97316',
    },
  },

  cloud: {
    driver: 'aws',
    region: 'us-east-1',
    domain: 'ts-cloud.stacksjs.com',
    subdomain: 'ts-cloud',
    baseDomain: 'stacksjs.com',
  },

  sidebar: [
    {
      text: 'Introduction',
      items: [
        { text: 'Overview', link: '/' },
        { text: 'Why ts-cloud', link: '/intro' },
      ],
    },
    {
      text: 'Getting Started',
      items: [
        { text: 'Installation', link: '/install' },
        { text: 'Quick Start', link: '/guide/getting-started' },
        { text: 'Configuration', link: '/config' },
        { text: 'Usage', link: '/usage' },
      ],
    },
    {
      text: 'Guide',
      items: [
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
        { text: 'Environments', link: '/features/environments' },
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
    {
      text: 'Community',
      items: [
        { text: 'Team', link: '/team' },
        { text: 'Sponsors', link: '/sponsors' },
        { text: 'Partners', link: '/partners' },
        { text: 'Showcase', link: '/showcase' },
        { text: 'Stargazers', link: '/stargazers' },
      ],
    },
    {
      text: 'Other',
      items: [
        { text: 'License', link: '/license' },
        { text: 'Postcardware', link: '/postcardware' },
      ],
    },
  ],

  navbar: [
    { text: 'Home', link: '/' },
    { text: 'Guide', link: '/guide/getting-started' },
    { text: 'Features', link: '/features/aws' },
    { text: 'Advanced', link: '/advanced/providers' },
    { text: 'GitHub', link: 'https://github.com/stacksjs/ts-cloud' },
  ],

  socialLinks: [
    { icon: 'github', link: 'https://github.com/stacksjs/ts-cloud' },
    { icon: 'discord', link: 'https://discord.gg/stacksjs' },
    { icon: 'twitter', link: 'https://twitter.com/stacksjs' },
  ],
}

export default config
