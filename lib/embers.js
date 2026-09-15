/* Ember field. Sparks rise off a coal glow at the bottom of the canvas; burst() throws a column of sparks when a burn
   lands on chain. With prefers-reduced-motion one still frame is drawn. */
export function embers(canvas, { density = 1 } = {}) {
  const ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const P = [];
  let W = 1, H = 1, extra = 0;

  function size() {
    const dpr = Math.min(2, devicePixelRatio || 1), r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function spawn(x, y, boost = 1) {
    P.push({
      x: x ?? Math.random() * W, y: y ?? H + Math.random() * 12,
      vx: (Math.random() - 0.5) * 0.35 * boost, vy: -(0.35 + Math.random() * 1.1) * boost,
      life: 0, max: 120 + Math.random() * 220, r: 0.6 + Math.random() * 1.8 * (boost > 1 ? 1.5 : 1), h: 12 + Math.random() * 28
    });
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W / 2, H * 1.15, 0, W / 2, H * 1.15, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(255,90,31,.26)'); g.addColorStop(0.5, 'rgba(120,30,8,.09)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const target = Math.round((W * H / 9000) * density) + extra;
    if (extra > 0) extra = Math.max(0, extra - 2);
    for (let i = P.length; i < target; i++) spawn();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life++; p.x += p.vx + Math.sin((p.life + p.h) * 0.05) * 0.25; p.y += p.vy; p.vy *= 0.998;
      const t = p.life / p.max;
      if (t >= 1 || p.y < -20) { P.splice(i, 1); continue; }
      const a = (t < 0.1 ? t / 0.1 : 1 - t) * 0.9, rr = p.r * (1 - t * 0.5);
      ctx.fillStyle = `hsla(${p.h},100%,${55 + 25 * (1 - t)}%,${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, 6.283); ctx.fill();
      ctx.fillStyle = `hsla(${p.h},100%,60%,${a * 0.16})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr * 4, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  function loop() { draw(); requestAnimationFrame(loop); }

  size();
  addEventListener('resize', () => { size(); if (still) draw(); });
  if (still) {
    for (let i = 0; i < 140; i++) { spawn(); P[i].y = Math.random() * H; P[i].life = Math.random() * 90; }
    draw();
  } else requestAnimationFrame(loop);

  return {
    burst(n = 90) {
      if (still) return;
      for (let i = 0; i < n; i++) spawn(W * (0.2 + Math.random() * 0.6), H + 4, 2.2);
      extra += n;
    }
  };
}
