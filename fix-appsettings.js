const { spawnSync } = require('node:child_process');
const val = process.argv[2];
const setArgs = [
  'webapp', 'config', 'appsettings', 'set',
  '--name', 'platform-api-bian',
  '--resource-group', 'Common_Services',
  '--settings', `POSTGRESQLSANDBOXPLATEFORMAPIURI=${val}`
];
const setRes = spawnSync('az', setArgs, { encoding: 'utf8' });
console.log(setRes.stdout);
console.log(setRes.stderr);
console.log('set_exit=' + setRes.status);
const listArgs = [
  'webapp', 'config', 'appsettings', 'list',
  '--name', 'platform-api-bian',
  '--resource-group', 'Common_Services',
  '--query', "[?name=='POSTGRESQLSANDBOXPLATEFORMAPIURI']",
  '-o', 'json'
];
const listRes = spawnSync('az', listArgs, { encoding: 'utf8' });
console.log(listRes.stdout);
console.log(listRes.stderr);
console.log('list_exit=' + listRes.status);
