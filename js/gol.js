/**
 * Game of Life simulation and display.
 * @param {HTMLCanvasElement} canvas Render target
 * @param {number} [scalePower] Size of each cell in pixels (as a power of 2)
 * @param {number} [interval] millis delay between each frame
 */
function GOL(canvas, config) {
    const defaultConfig = { scalePower : 2, interval : 60 };
    const combinedConfig = Object.assign({}, defaultConfig, config);

    this.canvas = canvas;
    var igloo = this.igloo = new Igloo(canvas);
    var gl = igloo.gl;
    if (gl == null) {
        alert('Could not initialize WebGL!');
        throw new Error('No WebGL');
    }
    this.combinedConfig = combinedConfig;
    this.scalePower = combinedConfig.scalePower;
    this.scale = Math.pow(2, this.scalePower);

    const scale = this.scale;
    this.interval = combinedConfig.interval;

    var w = canvas.width, h = canvas.height;
    this.viewsize = new Float32Array([w, h]);
    this.statesize = new Float32Array([w / scale, h / scale]);
    this.timer = null;
    this.lasttick = GOL.now();
    this.fps = 0;

    gl.disable(gl.DEPTH_TEST);
    this.programs = {
        copy: igloo.program('glsl/quad.vert', 'glsl/copy.frag'),
        gol:  igloo.program('glsl/quad.vert', 'glsl/gol.frag')
    };
    this.buffers = {
        quad: igloo.array(Igloo.QUAD2)
    };
    this.textures = {
        front: igloo.texture(null, gl.RGBA, gl.REPEAT, gl.NEAREST)
            .blank(this.statesize[0], this.statesize[1]),
        back: igloo.texture(null, gl.RGBA, gl.REPEAT, gl.NEAREST)
            .blank(this.statesize[0], this.statesize[1])
    };
    this.framebuffers = {
        step: igloo.framebuffer()
    };

    this.timings = {};
    this.numSteps = 0;
    this.everyNSteps = 100;

    $('.cell-size').text(`cell-size=${this.scale}`);
    $('.interval').text(`interval=${this.interval}`);
}

/**
 * @returns {number} The epoch in milliseconds
 */
GOL.nowMillis = function() {
    return Date.now();
};

/**
 * @returns {number} The epoch in integer seconds
 */
GOL.now = function() {
    return Math.floor(Date.now() / 1000);
};

/**
 * Compact a simulation state into a bit array.
 * @param {Object} state Array-like state object
 * @returns {ArrayBuffer} Compacted bit array
 */
GOL.compact = function(state) {
    var compact = new Uint8Array(state.length / 8);
    for (var i = 0; i < state.length; i++) {
        var ii = Math.floor(i / 8),
            shift = i % 8,
            bit = state[i] ? 1 : 0;
        compact[ii] |= bit << shift;
    }
    return compact.buffer;
};

/**
 * Expand a simulation state from a bit array.
 * @param {ArrayBuffer} compact Compacted bit array
 * @returns {Object} Array-like state object
 */
GOL.expand = function(buffer) {
    var compact = new Uint8Array(buffer),
        state = new Uint8Array(compact.length * 8);
    for (var i = 0; i < state.length; i++) {
        var ii = Math.floor(i / 8),
            shift = i % 8;
        state[i] = (compact[ii] >> shift) & 1;
    }
    return state;
};

/**
 * calc timings stats.
 * @param {number} interval average over last few
 * @returns {GOL} this
 */

GOL.prototype.calcTimingsStats = function(everyNSteps) {
    const stats = [`timings in millis, averaged over ${everyNSteps} steps:`, ''];
    Object.keys(this.timings).forEach( k => {
      const timingsOverInterval = this.timings[k].slice(- everyNSteps);
      const sum = timingsOverInterval.reduce( ( acc, cur ) => acc + cur, 0 );
      const divisor = (timingsOverInterval.length > 0) ? timingsOverInterval.length : 1;
      const avg = sum / divisor;
      stats.push(`${k}=${avg}`);
    });
    $('.timings').html(stats.join('<BR>'));
    return this;
};

/**
 * time one fn call.
 * @param {string} name name of action to be timed
 * @param {function} fn action to be timed
 * @returns {GOL} this
 */

GOL.prototype.timeFn = function(name, fn) {
  const beginTiming = GOL.nowMillis();
  fn();
  const endTiming = GOL.nowMillis();
  if (! this.timings.hasOwnProperty(name)) {
    this.timings[name] = [];
  }
  this.timings[name].push(endTiming - beginTiming);
  return this;
};

/**
 * Set the entire simulation state at once.
 * @param {Object} state Boolean array-like
 * @returns {GOL} this
 */
GOL.prototype.set = function(state) {
    var gl = this.igloo.gl;
    var rgba = new Uint8Array(this.statesize[0] * this.statesize[1] * 4);
    for (var i = 0; i < state.length; i++) {
        var ii = i * 4;
        rgba[ii + 0] = rgba[ii + 1] = rgba[ii + 2] = state[i] ? 255 : 0;
        rgba[ii + 3] = 255;
    }
    this.textures.front.subset(rgba, 0, 0, this.statesize[0], this.statesize[1]);
    return this;
};

/**
 * Fill the entire state with random values.
 * @param {number} [p] Chance of a cell being alive (0.0 to 1.0)
 * @returns {GOL} this
 */
GOL.prototype.setRandom = function(p) {
    var gl = this.igloo.gl, size = this.statesize[0] * this.statesize[1];
    p = p == null ? 0.5 : p;
    var rand = new Uint8Array(size);
    for (var i = 0; i < size; i++) {
        rand[i] = Math.random() < p ? 1 : 0;
    }
    this.set(rand);
    return this;
};

/**
 * Clear the simulation state to empty.
 * @returns {GOL} this
 */
GOL.prototype.setEmpty = function() {
    this.set(new Uint8Array(this.statesize[0] * this.statesize[1]));
    return this;
};

/**
 * Swap the texture buffers.
 * @returns {GOL} this
 */
GOL.prototype.swap = function() {
    var tmp = this.textures.front;
    this.textures.front = this.textures.back;
    this.textures.back = tmp;
    return this;
};

/**
 * Step the Game of Life state on the GPU without rendering anything.
 * @returns {GOL} this
 */
GOL.prototype.step = function() {
    this.numSteps ++;
    this.timeFn('step', () => {
      if (GOL.now() != this.lasttick) {
          $('.fps').text(this.fps + ' FPS');
          this.lasttick = GOL.now();
          this.fps = 0;
      } else {
          this.fps++;
      }
      var gl = this.igloo.gl;
      this.framebuffers.step.attach(this.textures.back);
      this.textures.front.bind(0);
      gl.viewport(0, 0, this.statesize[0], this.statesize[1]);
      this.programs.gol.use()
          .attrib('quad', this.buffers.quad, 2)
          .uniformi('state', 0)
          .uniform('scale', this.statesize)
          .draw(gl.TRIANGLE_STRIP, 4);
      this.swap();
    });

    if ((this.numSteps % this.everyNSteps) == 0) {
      this.calcTimingsStats(this.everyNSteps);
    }

    return this;
};

/**
 * Render the Game of Life state stored on the GPU.
 * @returns {GOL} this
 */
GOL.prototype.draw = function() {
  this.timeFn('draw', () => {
      var gl = this.igloo.gl;
      this.igloo.defaultFramebuffer.bind();
      this.textures.front.bind(0);
      gl.viewport(0, 0, this.viewsize[0], this.viewsize[1]);
      this.programs.copy.use()
          .attrib('quad', this.buffers.quad, 2)
          .uniformi('state', 0)
          .uniform('scale', this.viewsize)
          .draw(gl.TRIANGLE_STRIP, 4);
      });
    return this;
};

/**
 * Set the state at a specific position.
 * @param {number} x
 * @param {number} y
 * @param {boolean} state True/false for live/dead
 * @returns {GOL} this
 */
GOL.prototype.poke = function(x, y, state) {
    var gl = this.igloo.gl,
        v = state * 255;
    this.textures.front.subset([v, v, v, 255], x, y, 1, 1);
    return this;
};

/**
 * @returns {Object} Boolean array-like of the simulation state
 */
GOL.prototype.get = function() {
    var gl = this.igloo.gl, w = this.statesize[0], h = this.statesize[1];
    this.framebuffers.step.attach(this.textures.front);
    var rgba = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    var state = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) {
        state[i] = rgba[i * 4] > 128 ? 1 : 0;
    }
    return state;
};

/**
 * Run the simulation automatically on a timer.
 * @returns {GOL} this
 */
GOL.prototype.start = function() {
    if (this.timer == null) {
      const gol = this;
        this.timer = setInterval(function(){
            gol.step();
            gol.draw();
        }, this.interval);
    }
    return this;
};

/**
 * Stop animating the simulation.
 * @returns {GOL} this
 */
GOL.prototype.stop = function() {
    clearInterval(this.timer);
    this.timer = null;
    return this;
};

/**
 * Toggle the animation state.
 * @returns {GOL} this
 */
GOL.prototype.toggle = function() {
    if (this.timer == null) {
        this.start();
    } else {
        this.stop();
    }
};

/**
 * Find simulation coordinates for event.
 * This is a workaround for Firefox bug #69787 and jQuery bug #8523.
 * @returns {Array} target-relative offset
 */
GOL.prototype.eventCoord = function(event) {
    var $target = $(event.target),
        offset = $target.offset(),
        border = 1,
        x = event.pageX - offset.left - border,
        y = $target.height() - (event.pageY - offset.top - border);
    return [Math.floor(x / this.scale), Math.floor(y / this.scale)];
};

/**
 * Manages the user interface for a simulation.
 */
function Controller(gol) {
    this.gol = gol;
    gol.setRandom();
    gol.draw()
    gol.start();

    var _this = this,
        $canvas = $(gol.igloo.canvas);
    this.drag = null;

    function updateEvent(element, name, fn) {
      element.off(name);
      element.on(name, fn);
    }

    $canvas.off('mousedown');
    $canvas.on('mousedown', function(event) {
        _this.drag = event.which;
        var pos = gol.eventCoord(event);
        gol.poke(pos[0], pos[1], _this.drag == 1);
        gol.draw();
    });
    $canvas.off('mouseup');
    $canvas.on('mouseup', function(event) {
        _this.drag = null;
    });
    $canvas.off('mousemove');
    $canvas.on('mousemove', function(event) {
        if (_this.drag) {
            var pos = gol.eventCoord(event);
            gol.poke(pos[0], pos[1], _this.drag == 1);
            gol.draw();
        }
    });
    $canvas.off('contextmenu');
    $canvas.on('contextmenu', function(event) {
        event.preventDefault();
        return false;
    });
    $(document).off('keyup');
    $(document).on('keyup', function(event) {
        switch (event.which) {
        case 82: /* r */
            gol.setRandom();
            gol.draw();
            break;
        case 46: /* [delete] */
            gol.setEmpty();
            gol.draw();
            break;
        case 32: /* [space] */
            gol.toggle();
            break;
        case 83: /* s */
            if (event.shiftKey) {
                if (this._save) gol.set(this._save);
            } else {
                this._save = gol.get();
            }
            break;
        case 188: /* [comma] */
            gol.interval = (gol.interval==0)? 1 : gol.interval * 2;
            $('.interval').text(`interval=${gol.interval}`);
            gol.stop();
            gol.start();
            break;
        case 190: /* [period] */
            gol.interval = Math.floor(gol.interval / 2);
            $('.interval').text(`interval=${gol.interval}`);
            gol.stop();
            gol.start();
            break;
        case 189: /* [dash] */
            if ((gol.scalePower - 1) >= 0) {
              gol.stop();
              gol.setEmpty();
              const newGol = new GOL(gol.canvas, { scalePower : (gol.scalePower - 1), interval : gol.interval } );
              new Controller(newGol);
              $('.cell-size').text(`cell-size=${newGol.scale}`);
            }
            break;
        case 187: /* [equals] */
          if ((gol.scalePower + 1) <= 6) {
              gol.stop();
              gol.setEmpty();
              const newGol = new GOL(gol.canvas, { scalePower : (gol.scalePower + 1), interval : gol.interval } );
              new Controller(newGol);
              $('.cell-size').text(`cell-size=${newGol.scale}`);
            }
            break;
        };
    });
}

/* Initialize everything. */
$(document).ready(function() {
    var $canvas = $('#life');
    let gol = new GOL($canvas[0], { scalePower : 2, interval : 60 } );
    new Controller(gol);
});

/* Don't scroll on spacebar. */
$(window).on('keydown', function(event) {
    return !(event.keyCode === 32);
});
