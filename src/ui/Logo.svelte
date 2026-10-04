<!--
  The mark: an aircraft crossing the limb of the Earth. The same drawing as
  `public/favicon.svg`, inline so it draws with the page and needs no request.
-->
<script lang="ts">
  let { size = 24 }: { size?: number } = $props();
  const id = `logo-${Math.random().toString(36).slice(2, 8)}`;
</script>

<svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" class="logo">
  <defs>
    <linearGradient id="{id}-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0d2038" />
      <stop offset="1" stop-color="#03060c" />
    </linearGradient>
    <clipPath id="{id}-tile"><rect width="64" height="64" rx="14" /></clipPath>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#{id}-sky)" />
  <g clip-path="url(#{id}-tile)">
    <circle cx="32" cy="93" r="47" fill="#0a2740" stroke="#7fdfff" stroke-width="3" />
    <circle cx="32" cy="93" r="52" fill="none" stroke="#7fdfff" stroke-opacity=".28" stroke-width="3" />
  </g>
  <path
    fill="#f2f8ff"
    transform="translate(37 25) rotate(38) scale(.6) translate(-32 -31)"
    d="M32 7c2.6 0 4.3 3.1 4.6 8.4l.2 6.2 20.4 12.1a2 2 0 0 1 1 1.7v3.3c0 .9-.9 1.5-1.7 1.2L36.9 34l-.5 11.6 7.2 5.2c.5.4.8 1 .8 1.6v2.1c0 .8-.8 1.4-1.6 1.2L32 52.6l-10.8 3.1c-.8.2-1.6-.4-1.6-1.2v-2.1c0-.6.3-1.2.8-1.6l7.2-5.2-.5-11.6L7.5 39.9c-.8.3-1.7-.3-1.7-1.2v-3.3a2 2 0 0 1 1-1.7l20.4-12.1.2-6.2C27.7 10.1 29.4 7 32 7Z"
  />
</svg>

<style>
  .logo { display: block; flex-shrink: 0; }
</style>
