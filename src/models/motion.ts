import * as Settings from '../settings'
import * as Types from '../types'

export class Motion {
	mode: Types.ChallengeMode

	initialPosition: number
	initialVelocity: number

	junctions: Types.Junction[]
	ramps: Types.Ramp[]

	private _data: Types.MotionData[]

	get data() {
		if (this._data === undefined) {
			this.execute()
		}

		return this._data.slice()
	}

	static fromSetup(setup: Types.MotionSetup, mode?: Types.ChallengeMode) {
		// TODO: fetch challenge mode
		return new this(setup.position, setup.velocity, setup.posts, mode)
	}

	constructor(position: number, velocity: number, posts: number[], mode?: Types.ChallengeMode) {
		// For now only NORMAL mode is available
		this.mode = mode || Settings.MODE_NORMAL

		// Store initial motion setup
		this.initialPosition = position
		this.initialVelocity = velocity

		// Calculate individual ramp size in the given mode
		let trackSize = this.mode.domain.position.max
		let postCount = this.mode.postsCount
		let rampSize = trackSize / (postCount - 1)

		// --------
		// Store useful info about each ramp on the track

		this.ramps = []
		for (let n = 1; n < postCount; n++) {
			let rampSlope = posts[n - 1] - posts[n]

			// Ramp acceleration is given by g * sin(θ)
			// By small-angle approximation we know that sin(θ) ≈ tan(θ) = rampSlope / rampSize
			let rampSlopeCM = rampSlope * 100
			let acceleration = Settings.GRAVITY_ACCELERATION * (rampSlopeCM / rampSize)

			// TODO: I'm not sure why the acceleration needs to be in m/s², since almost everything else is cm/s
			acceleration = acceleration / 100

			this.ramps.push({
				number: n,
				left: rampSize * (n - 1),
				right: rampSize * n,
				slope: rampSlope,
				acceleration: acceleration
			})
		}

		// --------
		// Determine the initial height of the ball to find out its potential energy

		let initialRamp = this.getRampAt(position, velocity)
		// Relative position of the ball in the initial ramp, ranging from 0 to 1
		let relativePosition = (position - initialRamp.left) / rampSize
		// Height of the ramp at the initial ball position
		let initialHeight = posts[initialRamp.number - 1] - relativePosition * initialRamp.slope


		// --------
		// Store useful info about each ramp junction on the track

		let postIndex = 0
		this.junctions = []
		for (let junctionHeight of posts) {
			// --------
			// We use energy conservation law to estimate the ball speed at the height of this junction
			let relativeHeight = initialHeight - junctionHeight
			let radical = (velocity  ** 2) + (2 * Settings.GRAVITY_ACCELERATION * relativeHeight)


			let speed = 0
			if (radical < 0) {
				// The ball don't have enough energy to reach this height
				speed = null
			} else if (radical > 0) {
				// This is the stimated ball speed when crossing this junction
				speed = Math.sqrt(radical)
			}

			this.junctions.push({
				height: junctionHeight,
				speed: speed,
				position: rampSize * postIndex++
			})
		}
	}

	execute() {
		// Initialize data series with values for T=0
		let s = this.initialPosition
		let v = this.initialVelocity
		let r = this.getRampAt(s, v)
		let a = r.acceleration
		this.commitData(0, s, v, a)


		let dt = 1 / this.mode.simulation.precision
		let tMax = this.mode.simulation.duration
		let sDomain = this.mode.domain.position

		for (let t = dt; t <= tMax; t += dt) {
			// Calculate the next values and store them separately, so we can make some checkings first
			let nextPosition = s + (v * dt) + (((dt ** 2) * a) / 2)
			let nextVelocity = v + (a * dt)
			let nextRamp = this.getRampAt(nextPosition, nextVelocity)

			// Check if the ball still inside the track
			let fellOff = nextPosition < sDomain.min || sDomain.max < nextPosition
			if (t === dt && fellOff) {
				// We end it here if the ball fell of the track right after T=0
				break
			}

			if (r === nextRamp && !fellOff) {
				// No crossing occurred, ramp and acceleration still the same
				s = nextPosition
				v = v + (a * dt)
			} else {
				// --------
				// A ramp crossing occurred, here we go

				// Determine crossing junction and direction
				let leftToRight = v > 0
				let junctionIndex = Math.min(r.number, nextRamp.number)

				if (fellOff && !leftToRight) {
					junctionIndex--
				}

				let junction = this.junctions[junctionIndex]

				if (junction.speed === null) {
					console.warn(`The ball reached a junction that is too high for the amount of energy in the system. Something is wrong!`)
				}

				// Distance between the previous position and the junction
				let dsA = Math.abs(junction.position - s)

				if (dsA === 0) {
					// Ramp changed, however previous position was exactly over the junction
					// This means we don't need to split the calculation in two, just recalculate using the new acceleration
					// To test this edge case, use 250, -10, [0, 8, 0, 0, 6, 0]
					r = nextRamp
					a = r.acceleration
					s = s + (v * dt) + (((dt ** 2) * a) / 2)
					v = v + (a * dt)
				} else {
					// --------
					// Calculate the motion from the last postion until the ramp junction

					// Average ball speed before the crossing
					let speedA = (junction.speed + Math.abs(v)) / 2

					// Amount of time elapsed before the crossing
					let dtA = dsA / speedA
					if (dtA >= dt) {
						console.warn('Junction crossing has partial time bigger than full time. Something is wrong!')
					}

					// Commit a data point at the exact moment of the crossing
					let tA = t - dt + dtA
					let vA = junction.speed * (leftToRight ?  1 : -1)
					this.commitData(tA, junction.position, vA, a)

					// --------
					// Now calculate the values after crossing the ramp junction

					if (fellOff) {
						// End the simulation here if the ball fell off the track
						// it has just crossed the junction on the track edge
						break
					}

					// Update the ramp and acceleration
					r = nextRamp
					a = r.acceleration

					// Amount of time elapsed after the crossing
					let dtB = dt - dtA

					// Calculate the final position and velocity
					// but this time starting off from the junction
					s = junction.position + (vA * dtB) + (((dtB ** 2) * a) / 2)
					v = vA + (a * dtB)

					// Everything should be ok now, the loop can continue normally
				}
			}

			this.commitData(t, s, v, a)
		}
	}

	private getRampAt(position: number, velocity: number) {
		let r = this.ramps
		let idx: number
		for (idx = 0; idx < r.length; idx++) {
			if (r[idx].right > position) {
				// The ball is contained in this ramp

				let overLeftJunction = r[idx].left === position
				if (overLeftJunction && idx > 0) {
					// Ball is exactly at the start of the ramp so we
					// test some edge cases when the previous ramp must be selected

					if (velocity === 0) {
						// Ball has zero velocity, so we make it fall towards
						// the right ramp if it has a bigger slope
						if (Math.abs(r[idx - 1].slope) > Math.abs(r[idx].slope)) {
							idx--
						}
					} else if (velocity < 0) {
						// Ball is heading to the right
						// so we select the previous ramp
						idx--
					}
				}

				break
			}
		}

		if (idx === r.length) {
			// This happens when no ramp was found
			// the ball fell out on the right edge, just select the last ramp
			idx--
		}

		return r[idx]
	}

	private commitData(t: number, s: number, v: number, a: number) {
		if (t === 0 || this._data === undefined) {
			this._data = []
		}

		this._data.push({ t: t, s: s, v: v, a: a })
	}
}
