import { len, normAngle } from '../physics/math.js';

const REFERENCE_FOV_DEG = 85;

export function createCameraState() {
  return { x: 0, y: 20, zoom: 1, angle: 0 };
}

export function updateFollowCamera(camera, {
  boat,
  tube,
  dt,
  snap = false,
  view,
  viewportWidth,
  showDigitalGauges,
  fovDeg
}) {
  const mobile = viewportWidth <= 700;
  const useOpenMobileFraming = mobile && !showDigitalGauges;
  let targetX = boat.x;
  let targetY = boat.y;
  let targetAngle = 0;
  let targetZoom = 1;

  if (view === 'driver') {
    const lookAhead = useOpenMobileFraming ? 55 : 82;
    targetX = boat.x + Math.cos(boat.angle) * lookAhead;
    targetY = boat.y + Math.sin(boat.angle) * lookAhead;
    targetAngle = -boat.angle - Math.PI / 2;
    targetZoom = mobile ? 1.22 : 1.5;
  } else if (view === 'tube') {
    const followAngle = len(tube.vx || 0, tube.vy || 0) > 10
      ? Math.atan2(tube.vy, tube.vx)
      : tube.angle;
    const lookAhead = useOpenMobileFraming ? 20 : 35;
    targetX = tube.x + Math.cos(followAngle) * lookAhead;
    targetY = tube.y + Math.sin(followAngle) * lookAhead;
    targetAngle = -followAngle - Math.PI / 2;
    targetZoom = mobile ? 1.34 : 1.65;
  } else if (view === 'person') {
    const body = tube.fallenRider || tube;
    const followAngle = len(body.vx || 0, body.vy || 0) > 6
      ? Math.atan2(body.vy, body.vx)
      : body.angle;
    const lookAhead = useOpenMobileFraming ? 8 : 14;
    targetX = body.x + Math.cos(followAngle) * lookAhead;
    targetY = body.y + Math.sin(followAngle) * lookAhead;
    targetAngle = -followAngle - Math.PI / 2;
    targetZoom = mobile ? 1.72 : 2.12;
  }

  const fovZoom = Math.tan(REFERENCE_FOV_DEG * Math.PI / 360)
    / Math.tan(fovDeg * Math.PI / 360);
  targetZoom *= fovZoom;

  if (snap) {
    camera.x = targetX;
    camera.y = targetY;
    camera.angle = targetAngle;
    camera.zoom = targetZoom;
    return camera;
  }

  camera.x += (targetX - camera.x) * dt * 2.8;
  camera.y += (targetY - camera.y) * dt * 2.8;
  camera.angle += normAngle(targetAngle - camera.angle) * dt * 3.2;
  camera.zoom += (targetZoom - camera.zoom) * dt * 3;
  return camera;
}
