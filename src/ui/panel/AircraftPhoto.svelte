<!--
  Airframe photo with its credit.

  The credit and the link back are a condition of the Planespotters API, not
  decoration — they render whenever a photo does, and the component is built so
  that the two cannot be separated by a later edit.
-->
<script lang="ts">
  import type { AircraftPhoto } from '@/data/types';

  let { photo, alt }: { photo: AircraftPhoto; alt: string } = $props();
</script>

<figure>
  <img src={photo.largeUrl} {alt} loading="lazy" />
  <figcaption>
    {#if photo.link}
      <a href={photo.link} target="_blank" rel="noopener noreferrer">
        {photo.photographer ?? 'Planespotters'}
      </a>
    {:else}
      {photo.photographer ?? 'Photo: airport-data.com'}
    {/if}
  </figcaption>
</figure>

<style>
  figure { margin: 14px 0 0; }
  img {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 2;
    object-fit: cover;
    border: 1px solid var(--border);
    background: #050a12;
  }
  figcaption {
    margin-top: 4px;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    text-align: right;
  }
  figcaption a { color: inherit; }
</style>
