<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from 'vue-i18n';
import './order-journey.css';

// The owner's order-animation.jsx is the artwork/timing reference; the scene is decorative.
const { t } = useI18n();
const markId = `delivery-mark-${useId().replace(/[^a-z0-9-]/gi, '')}`;
const base = import.meta.env.BASE_URL;
const rows = [0, 1, 2] as const;
const wheels = [90, 330, 530] as const;
</script>

<template>
  <div class="order-journey" aria-hidden="true">
    <svg class="journey-art" viewBox="0 0 1080 1080" fill="none" focusable="false">
      <defs>
        <g :id="markId">
          <rect x="24" y="42" width="28" height="52" rx="14" class="delivery-ink" />
          <path d="M58 38V6a32 32 0 0 1 32 32Z" class="delivery-orange" />
        </g>
      </defs>
      <g class="delivery-camera">
        <path class="delivery-ground" d="M0 820h1080" />
        <g class="delivery-phone">
          <rect width="340" height="680" rx="54" class="delivery-phone-edge" />
          <rect x="10" y="10" width="320" height="660" rx="44" class="delivery-paper" />
          <rect x="125" y="22" width="90" height="24" rx="12" class="delivery-ink" />
          <use :href="`#${markId}`" transform="translate(28 60) scale(.4)" />
          <rect x="76" y="72" width="120" height="12" rx="6" class="delivery-ink" />
          <rect x="76" y="92" width="70" height="9" rx="4.5" class="delivery-muted" />
          <g v-for="row in rows" :key="row" :transform="`translate(22 ${130 + row * 96})`">
            <rect width="296" height="84" rx="20" class="delivery-white" />
            <g
              :class="`delivery-thumbnail delivery-thumbnail--${row}`"
              transform="translate(10 10)"
            >
              <rect width="64" height="64" rx="16" class="delivery-soft" />
              <rect
                v-if="row === 0"
                x="21"
                y="12"
                width="22"
                height="40"
                rx="11"
                class="delivery-ink"
              />
              <path
                v-else-if="row === 1"
                d="M18 16h34v34a34 34 0 0 1-34-34Z"
                class="delivery-orange"
              />
              <g v-else>
                <circle cx="32" cy="32" r="16" class="delivery-ink" />
                <circle cx="32" cy="32" r="7" class="delivery-orange" />
              </g>
            </g>
            <rect x="88" y="24" :width="104 - row * 14" height="11" rx="5.5" class="delivery-ink" />
            <rect x="88" y="46" width="62" height="9" rx="4.5" class="delivery-muted" />
            <rect x="228" y="28" width="56" height="28" rx="14" class="delivery-soft" />
            <circle cx="247" cy="42" r="4" class="delivery-orange" />
            <circle cx="261" cy="42" r="4" class="delivery-orange" />
          </g>
          <path d="M32 442h276" class="delivery-divider" />
          <rect x="32" y="466" width="80" height="10" rx="5" class="delivery-muted" />
          <rect x="222" y="462" width="96" height="16" rx="8" class="delivery-ink" />
          <g class="journey-submit delivery-press">
            <rect x="28" y="572" width="284" height="76" rx="38" class="delivery-orange" />
            <path
              d="M127 597h8l8 30h35l7-23h-48m12 34h1m23 0h1m22-28h26m-11-10 10 10-10 10"
              class="delivery-button-icon"
            />
          </g>
          <circle class="delivery-ripple" cx="170" cy="610" r="50" />
        </g>
        <g class="delivery-truck">
          <g class="delivery-truck-body">
            <rect x="-10" y="206" width="630" height="28" rx="10" class="delivery-phone-edge" />
            <rect width="440" height="220" rx="16" class="delivery-paper" />
            <rect x="14" y="20" width="120" height="190" rx="8" class="delivery-ink" />
            <use :href="`#${markId}`" transform="translate(210 30) scale(1.5)" />
            <path
              d="M460 70h94a56 56 0 0 1 56 56v82a12 12 0 0 1-12 12H458a8 8 0 0 1-8-8V80a10 10 0 0 1 10-10Z"
              class="delivery-orange"
            />
            <path
              d="M476 90h56a34 34 0 0 1 34 34v18a6 6 0 0 1-6 6h-84a6 6 0 0 1-6-6V96a6 6 0 0 1 6-6Z"
              class="delivery-ink"
            />
            <rect x="470" y="162" width="36" height="6" rx="3" class="delivery-ink" />
            <rect x="598" y="178" width="12" height="20" rx="4" class="delivery-paper" />
            <g v-for="wheel in wheels" :key="wheel" :transform="`translate(${wheel} 256)`">
              <g class="delivery-wheel">
                <circle r="44" class="delivery-ink" />
                <circle r="22" class="delivery-muted" />
                <path d="M0-18v36m-18-18h36" class="delivery-wheel-spokes" />
                <circle r="6" class="delivery-orange" />
              </g>
            </g>
          </g>
          <path class="delivery-speed" d="M-220 90H-40m-230 60h180m-150 60h160" />
        </g>
        <g class="delivery-box">
          <g class="delivery-box-bounce">
            <rect x="-80" y="-130" width="160" height="12" rx="4" class="delivery-box-inside" />
            <path d="M-80-125H0" class="delivery-flap delivery-flap--left" />
            <path d="M0-125h80" class="delivery-flap delivery-flap--right" />
            <g v-for="row in rows" :key="row" :class="`delivery-item delivery-item--${row}`">
              <rect x="-32" y="-32" width="64" height="64" rx="16" class="delivery-soft" />
              <rect
                v-if="row === 0"
                x="-11"
                y="-20"
                width="22"
                height="40"
                rx="11"
                class="delivery-ink"
              />
              <path
                v-else-if="row === 1"
                d="M-17-17h34v34A34 34 0 0 1-17-17Z"
                class="delivery-orange"
              />
              <g v-else>
                <circle r="16" class="delivery-ink" />
                <circle r="7" class="delivery-orange" />
              </g>
            </g>
            <rect x="-80" y="-120" width="160" height="120" rx="10" class="delivery-box-front" />
            <use :href="`#${markId}`" transform="translate(-28 -80) scale(.56)" />
            <rect class="delivery-tape" x="-16" y="-130" width="32" height="46" rx="3" />
          </g>
        </g>
        <!-- Above the parcel so it disappears inside the truck when its shutter closes. -->
        <g class="delivery-truck delivery-truck--shutter">
          <g class="delivery-truck-body">
            <g class="delivery-shutter">
              <rect x="14" y="20" width="120" height="190" rx="8" class="delivery-paper" />
              <path
                v-for="row in 7"
                :key="row"
                :d="`M14 ${20 + row * 25}h120`"
                class="delivery-divider"
              />
              <rect x="54" y="190" width="40" height="8" rx="4" class="delivery-ink" />
            </g>
          </g>
        </g>
        <g class="delivery-finger"><circle r="36" /></g>
        <g class="delivery-done">
          <g
            v-for="piece in 8"
            :key="piece"
            :transform="`translate(540 420) rotate(${piece * 45})`"
          >
            <rect class="delivery-confetti-piece" x="-7" y="-13" width="14" height="26" rx="7" />
          </g>
          <g class="delivery-success">
            <circle cx="540" cy="420" r="110" class="delivery-orange" />
            <g class="delivery-check"><path d="m496 424 32 32 58-64" /></g>
          </g>
          <text class="delivery-caption" x="540" y="620" text-anchor="middle">
            {{ t('signIn.journeyAccepted') }}
          </text>
          <image
            class="delivery-logo"
            :href="`${base}header-dark.png`"
            x="359"
            y="700"
            width="362"
            height="120"
          />
        </g>
      </g>
    </svg>
  </div>
</template>
