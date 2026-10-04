<!--
  Airframe photo with its credit and licence.

  The photographer, the licence and the link to the file page are a condition
  of the Creative Commons licences these photographs are published under, not
  decoration — they render whenever a photo does, and the component is built so
  that they cannot be separated by a later edit.
-->
<script lang="ts">
  import type { AircraftPhoto } from '@/data/types';

  let { photo, alt }: { photo: AircraftPhoto; alt: string } = $props();

  // A dead link is shown as what it is — no photo — not as a broken image.
  let failed = $state(false);
  $effect(() => {
    void photo.largeUrl;
    failed = false;
  });
</script>

{#if failed}
  <div class="no-photo" role="img" aria-label="No photo available">
    <span>No photo available for this aircraft</span>
  </div>
{:else}
<figure>
  <img src={photo.largeUrl} {alt} loading="lazy" onerror={() => (failed = true)} />
  <figcaption>
    <a href={photo.link} target="_blank" rel="noopener noreferrer">
      {photo.photographer ?? 'Wikimedia Commons'} · {photo.license}
    </a>
  </figcaption>
</figure>
{/if}

<style>
  figure { margin: 14px 0 0; }
  img {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 2;
    object-fit: cover;
    border: 1px solid var(--border);
    background: var(--bg-panel-solid);
  }
  figcaption {
    margin-top: 4px;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    text-align: right;
  }
  figcaption a { color: inherit; }
  .no-photo {
    margin: 14px 0 0;
    aspect-ratio: 3 / 2;
    display: grid;
    place-items: center;
    border: 1px dashed var(--border);
    background: var(--bg-panel-solid);
    color: var(--text-faint);
    font-size: 11.5px;
    text-align: center;
    padding: 0 16px;
  }
</style>
