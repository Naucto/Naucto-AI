/** Optional Lua helpers; gameplay meaning is explicit and lives in reviewed game code. */
export const templates = {
  'top-down': `-- Naucto AI optional tile movement helper. Units: tiles.
-- Install only through a reviewed code proposal.
-- Fill this table with confirmed SOLID sprite numbers from the catalog.
local solid_tiles = {}

local function walkable(tx, ty)
  if tx < 0 or ty < 0 or tx >= map.width() or ty >= map.height() then
    return false
  end
  return not solid_tiles[map.get(tx, ty)]
end

local function try_step(player, dx, dy)
  local tx, ty = player.tx + dx, player.ty + dy
  if walkable(tx, ty) then player.tx, player.ty = tx, ty end
end
-- Example: try_step(player, 1, 0)
-- Render the player at player.tx * 8, player.ty * 8.
`,
  platformer: `-- Naucto AI optional platformer helper. Units: tiles and seconds.
-- Match these values when requesting reference-profile validation.
-- Install only through a reviewed code proposal.
local physics = { speed = 3, jump = 6, gravity = 20, width = 0.75, height = 1 }
local solid_tiles = {} -- confirmed SOLID sprite numbers only

local function clear(x, y)
  if x < 0 or y < 0 or x + physics.width > map.width()
     or y + physics.height > map.height() then return false end
  for ty = math.floor(y), math.floor(y + physics.height - 0.000001) do
    for tx = math.floor(x), math.floor(x + physics.width - 0.000001) do
      if solid_tiles[map.get(tx, ty)] then return false end
    end
  end
  return true
end

local function step_player(player, direction, jump_pressed, dt)
  dt = math.min(dt, 1 / 15)
  local grounded = clear(player.x, player.y) and not clear(player.x, player.y + 0.01)
  if jump_pressed and grounded then player.vy = -physics.jump end
  local steps = math.max(1, math.ceil(dt * 240))
  local step = dt / steps
  for i = 1, steps do
    local nx = player.x + direction * physics.speed * step
    if clear(nx, player.y) then player.x = nx end
    player.vy = math.min(30, player.vy + physics.gravity * step)
    local ny = player.y + player.vy * step
    if clear(player.x, ny) then player.y = ny else player.vy = 0 end
  end
end
-- Example: step_player(player, direction, jump_pressed, dt)
-- The bounded MCP solver is approximate; playtest the actual game as well.
`,
  levels: `-- Naucto AI optional level helper. Maps are numbered from 1 in the MAP tab's order.
-- Install only through a reviewed code proposal; markers are explicit, never guessed from art.
local levels = {
  -- { map = 1, spawn = { tx = 2, ty = 10 }, exit = { tx = 60, ty = 4 } },
}
local current = 1

local function level() return levels[current] end

local function start_level(index, player)
  current = index
  local spawn = level().spawn
  player.x, player.y = spawn.tx, spawn.ty
end

-- Call after moving the player (positions in tiles).
local function check_exit(player)
  local exit = level().exit
  if math.floor(player.x) == exit.tx and math.floor(player.y) == exit.ty then
    if levels[current + 1] then start_level(current + 1, player) else return "finished" end
  end
end

local function draw_level()
  map.draw(0, 0, 0, 0, map.width(level().map), map.height(level().map), level().map)
end
-- Pass level().map as the last argument to map.get/map.width/map.height as well.
`,
};
