
const exec = `
  cd $@
  ../../../cli.js clean
  ../../../cli.js
  ../../../cli.js
  ../../../cli.js clean
`

module.exports = {

  all: { deps: ['toml', 'json', 'yaml', 'cjs', 'mjs', 'md'] },

  toml: { exec },
  json: { exec },
  yaml: { exec },
  cjs: { exec },
  mjs: { exec },
  md: { exec }

}
