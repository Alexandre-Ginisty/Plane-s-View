<!--
  One icon set for the whole app.

  Line icons on a 24-unit grid, drawn with `currentColor`, so an icon takes the
  colour and the hover state of whatever button it sits in and needs no
  per-theme variant. Inline SVG rather than a font or a sprite: nothing to
  download, and each one is a few dozen bytes.
-->
<script lang="ts" module>
  const PATHS = {
    pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
    key: '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    landing: '<path d="M2.5 20.5h19"/><path d="M4 9.5 7 9l3 3 6.5-1.6a2 2 0 0 1 1 3.9L6.2 17 3 12.8Z"/>',
    takeoff: '<path d="M2.5 20.5h19"/><path d="m3.5 14.5 2.4-1 3 2 6.4-3.7a2 2 0 0 1 2 3.5L7 21 3.5 17Z" transform="translate(0 -4)"/>',
    cockpit: '<path d="M3 16c2-6 5.5-9 9-9s7 3 9 9"/><path d="M3 16h18"/><path d="M12 7v9M7.5 9.5 9.5 16M16.5 9.5 14.5 16"/>',
    window: '<rect x="6" y="3" width="12" height="18" rx="6"/><rect x="8.5" y="6" width="7" height="12" rx="3.5"/><path d="M8.5 10.5h7"/>',
    chase: '<path d="M12 4v12"/><path d="M4 11.5 12 9l8 2.5"/><path d="m9 16 3-1 3 1"/><path d="M12 20.5v.01"/><path d="M8 20a6 6 0 0 1 8 0" opacity=".6"/>',
    wing: '<path d="M3 13.5h7l8-5.5h2.5l-4 5.5H21"/><path d="M3 13.5 5 17h6"/>',
    orbit: '<ellipse cx="12" cy="12" rx="9.5" ry="4.2"/><path d="M12 9.2v.01"/><path d="m7 12 5-2.8 5 2.8-5 1.6Z"/><path d="m18.5 6.5 2 1.3-2.2 1"/>',
    sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    auto: '<path d="M4 20 10.5 4h3L20 20"/><path d="M7 14h10"/><path d="M19.5 3.5 21 5l-1.5 1.5"/>',
    fullscreen: '<path d="M3.5 9V3.5H9M15 3.5h5.5V9M20.5 15v5.5H15M9 20.5H3.5V15"/>',
    back: '<path d="M10 5 3 12l7 7"/><path d="M3.5 12H21"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    map: '<path d="M3.5 6.5 9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5-5.5 2.5Z"/><path d="M9 4v13.5M15 6.5V20"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    minus: '<path d="M5.5 12h13"/>',
    shuffle: '<path d="M3 7h3.5c5 0 6 10 11 10H21"/><path d="M3 17h3.5c2 0 3.2-1.6 4.2-3.5M13.3 9.5C14.3 8 15.5 7 17.5 7H21"/><path d="m18.5 4.5 2.5 2.5-2.5 2.5M18.5 14.5l2.5 2.5-2.5 2.5"/>',
    details: '<rect x="3.5" y="4" width="17" height="16" rx="1.5"/><path d="M7.5 9h9M7.5 13h9M7.5 17h5"/>',
    home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5V14h4v5.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9Z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>',
    camera: '<path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.5l1.6-2.3h5.8L16.5 7H19a1.5 1.5 0 0 1 1.5 1.5v9.5A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18Z"/><circle cx="12" cy="13" r="3.6"/>',
    record: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
    stop: '<circle cx="12" cy="12" r="8.5"/><rect x="8.8" y="8.8" width="6.4" height="6.4" rx="1" fill="currentColor" stroke="none"/>',
    gyro: '<rect x="7.5" y="3" width="9" height="18" rx="2"/><path d="M11 18h2"/><path d="M3.5 9a8 8 0 0 0 0 6M20.5 9a8 8 0 0 1 0 6"/>',
    recentre: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
    moon: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.6 8.6 0 1 0 20 14.2Z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8"/><path d="M12 17.2v.01"/>',
    plane: '<path d="M21 15.5v-2l-8-5V3.8a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-6Z"/>',
  } as const;

  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="icon"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  aria-hidden="true"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  {@html PATHS[name]}
</svg>

<style>
  .icon { flex-shrink: 0; display: block; }
</style>
