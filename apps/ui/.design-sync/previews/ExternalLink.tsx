import { ExternalLink } from "metagraphed-ui";

export function Default() {
  return <ExternalLink href="https://taostats.io">View on Taostats</ExternalLink>;
}

export function AuthRequired() {
  return (
    <ExternalLink href="https://docs.metagraphed.example/api" authRequired>
      API reference
    </ExternalLink>
  );
}

export function NotPublicSafe() {
  return (
    <ExternalLink href="https://internal.example.com/dashboard" publicSafe={false}>
      Internal dashboard
    </ExternalLink>
  );
}
