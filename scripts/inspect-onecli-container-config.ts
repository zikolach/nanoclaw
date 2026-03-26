import { OneCLI } from '@onecli-sh/sdk';

async function main() {
  const agent = process.argv[2];
  const onecli = new OneCLI();
  const config = await onecli.getContainerConfig(agent);

  console.log(
    JSON.stringify(
      {
        agent: agent || null,
        envKeys: Object.keys(config.env).sort(),
        envPreview: config.env,
        caCertificateContainerPath: config.caCertificateContainerPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
