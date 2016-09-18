import { Component, OnInit, ViewChild, transition, style, animate, trigger, ChangeDetectorRef } from '@angular/core'
import { ActivatedRoute, Router } from '@angular/router'
import { Challenge, Attempt, MotionSetup, DataType, MotionData, Hint, AttemptError, CHALLENGE_TYPE } from '../../shared/types'
import { printDataTable } from '../../shared/debug'
import { interpolate } from '../../shared/helpers'
import { HINTS, ANIMATION_DURATION } from '../../shared/settings'
import { ChallengesService } from '../../shared/challenges.service'
import { Motion } from '../../shared/motion.model'
import { GraphsComponent } from '../../shared/graphs/graphs.component'
import { TrackPanelComponent } from '../../shared/track-panel/track-panel.component'
import { AuthService } from '../../shared/auth.service'

const SWITCH_DURATION = 300
type SwitchDirection = 'toLeft' | 'toRight' | 'none'

@Component({
	selector: 'gt-challenge',
	templateUrl: './challenge.component.html',
	styleUrls: ['./challenge.component.scss'],
	animations: [
		trigger('challengeSwitch', [
			transition('void => toRight', [ // Entering from right
				style({ transform: 'translateX(-100%) scale(.2)', opacity: 0.0 }),
				animate(`${SWITCH_DURATION}ms ease-out`, style({ transform: 'translateX(0%) scale(1)', opacity: 1.0 }))
			]),
			transition('void => toLeft', [ // Entering from left
				style({ transform: 'translateX(100%) scale(.2)', opacity: 0.0 }),
				animate(`${SWITCH_DURATION}ms ease-out`, style({ transform: 'translateX(0%) scale(1)', opacity: 1.0 }))
			]),
			transition('toRight => void', [ // Leaving from right
				animate(`${SWITCH_DURATION}ms ease-in`, style({ transform: 'translateX(100%) scale(.6)', opacity: 0.0 }))
			]),
			transition('toLeft => void', [ // Leaving from left
				animate(`${SWITCH_DURATION}ms ease-in`, style({ transform: 'translateX(-100%) scale(.6)', opacity: 0.0 }))
			])
		]
	)]
})
export class ChallengeComponent implements OnInit {
	@ViewChild(TrackPanelComponent)
	trackPanel: TrackPanelComponent

	@ViewChild(GraphsComponent)
	graphsPanel: GraphsComponent

	challengeId: string
	challenge: Challenge

	collectionIndex: number
	collectionIds: string[]
	switchDirection: SwitchDirection = 'none'

	goalMotion: Motion
	isDemo: boolean = false
	isReady: boolean = false
	isLoadingNext: boolean = false

	segmentedAnimationIndex: number

	hintsEnabled: boolean = false
	hintDismissed: boolean = false
	currentHint: Hint

	attempts: Attempt[] = []
	commitedAttempts: number = 0
	latestError: AttemptError

	constructor(
		private challenges: ChallengesService,
		private router: Router,
		private changeDetector: ChangeDetectorRef,
		public  auth: AuthService,
		route: ActivatedRoute
	) {
		this.challengeId = route.snapshot.params['id']
		route.params.subscribe(p => this.loadChallengeById(p['id']))
	}

	ngOnInit() {
		this.isReady = true
		this.loadChallengeById(this.challengeId)
	}

	onRollBall(setup: MotionSetup) {
		this.performMotion(setup)
	}

	onGraphPanelChange(dataType: DataType) {
		this.segmentedAnimationIndex = undefined
		this.trackPanel.updateBallPostion()
	}

	onTrackPanelChange(dataType: DataType) {
		this.segmentedAnimationIndex = undefined
		if (dataType === 's' || dataType === 'v') {
			this.graphsPanel.refresh(false, true)
		}
	}

	onHintToggle() {
		this.hintsEnabled = !(this.hintsEnabled)

		if (this.hintsEnabled) {
			this.hintDismissed = false
			this.currentHint = HINTS['intro']
		} else {
			this.clearHints()
		}
	}

	navigateTo(direction: SwitchDirection) {
		if (this.isLoadingNext === true) {
			return false
		}

		if (this.auth.user.settings.effects) {
			this.switchDirection = direction
			this.changeDetector.detectChanges()
		} else {
			this.switchDirection = 'none'
		}

		let newIndex = this.collectionIndex + (direction === 'toLeft' ? 1 : -1)
		let newId = this.collectionIds[newIndex]
		if (newId) {
			this.router.navigate(['challenges', newId])

			this.isLoadingNext = true
			setTimeout(() => {
				this.isLoadingNext = false
			}, SWITCH_DURATION)
		}
	}

	loadChallengeById(challengeId: string) {
		if (this.isReady === false) {
			return
		}

		let challenge = this.challenges.getById(challengeId)
		if (challenge) {
			this.loadChallenge(challenge)
		} else {
			// TODO: navigate 404
		}
	}

	loadChallenge(challenge: Challenge) {
		this.clearHints()
		this.segmentedAnimationIndex = undefined

		if (this.collectionIds === undefined || this.challenge.type !== challenge.type) {
			this.collectionIds = this.challenges.getIdsInCollection(challenge.type)
		}

		this.challenge = challenge
		this.challengeId = challenge.id
		this.collectionIndex = this.collectionIds.indexOf(challenge.id)

		this.goalMotion = Motion.fromSetup(this.challenge.goal, this.challenge.mode)

		this.isDemo =
			this.challenge.type === CHALLENGE_TYPE.TUTORIAL ||
			this.challenge.type === CHALLENGE_TYPE.EXPLORATION

		if (this.challenge.type === CHALLENGE_TYPE.TUTORIAL) {
			this.startTutorial()
		}
	}

	startTutorial() {
		// TODO
	}

	performMotion(setup: MotionSetup) {
		let trialMotion = Motion.fromSetup(setup)

		let isContinuation = this.segmentedAnimationIndex !== undefined

		if (isContinuation) {
			this.latestError = undefined
		} else {
			this.graphsPanel.addTrialData(trialMotion.data)

			if (setup.breakDown) {
				// TODO: how to deal with hints and partial motions ?
				this.hintsEnabled = false
				this.segmentedAnimationIndex = 0
			}

			this.latestError = this.goalMotion.findTrialError(trialMotion)
			if (this.latestError) {
				this.attempts.push({
					accuracy: -1,
					setup: setup,
					motion: trialMotion
				})
			}
		}

		this.clearHints()
		this.trackPanel.cancelBallReset()
		this.animate(trialMotion.data, ANIMATION_DURATION, setup.breakDown)
	}

	animate(motion: MotionData[], duration: number, breakdown = false) {
		this.trackPanel.rolling = true
		let animationStartedAt = Date.now()
		duration *= 1000

		// Ratio between real time and simulation time
		let timeRatio = (this.challenge.mode.simulation.duration * 1000) / duration

		// Index of which data point the animation is currently on
		// the index will be increased accordly with the amount of time elapsed
		let idx = this.segmentedAnimationIndex || 0
		let firstPoint = motion[idx]

		// If the animation isn't starting from the beggining
		// Adjust the real time offset to reflect that
		if (idx !== 0) {
			let timeToSkip = firstPoint.t * 1000
			animationStartedAt -= (timeToSkip / timeRatio)
		}

		// If animating in breakdown mode, make the accelaration of the initial frame
		// required to keep the animation going
		let requiredAcceleration = breakdown ? firstPoint.a : undefined


		let animationFrame = () => {
			let now = Date.now()
			let elapsedTime = now - animationStartedAt

			if (!(this.trackPanel.rolling) || elapsedTime > duration) {
				this.endAnimation()
				return
			}

			let t = elapsedTime * timeRatio
			let currentTime, nextTime, lastFound = idx, found = false
			while (idx < (motion.length - 1)) {
				if (requiredAcceleration !== undefined && motion[idx + 1].a !== requiredAcceleration) {
					// TODO: accelleration change isn't detected EXACTLY over a post head (interpolate?)
					// Suspend the animation until the user rolls again
					this.segmentedAnimationIndex = idx + 1
					this.endAnimation(true)
					return
				}

				currentTime = Math.floor(motion[idx].t * 1000)
				nextTime = Math.floor(motion[idx + 1].t * 1000)
				if (currentTime <= t && t < nextTime) {
					// This index is surrounded by two data points that have our current animation time
					// som we can interpolate the current position value from them
					found = true
					break
				} else {
					idx++
				}
			}

			let position
			if (found) {
				let current = motion[idx]
				let next = motion[idx + 1]
				position = interpolate(t, currentTime, nextTime, current.s, next.s)

				// queue next animation frame
				requestAnimationFrame(animationFrame)
			} else {
				let lastPoint = motion[lastFound + 1]
				if (lastPoint) {
					position = lastPoint.s
				} else {
					// It's probably a motion with a single data point (ball fall off right after T=0)
					position = motion[0].s
				}

				this.endAnimation()
			}

			if (typeof position !== 'number') {
				throw 'Last data point not found'
			}

			this.graphsPanel.setTrialLineClip(elapsedTime / duration)
			this.trackPanel.updateBallPostion(position)
		}

		animationFrame()
	}

	endAnimation(justPause = false) {
		this.commitedAttempts = this.attempts.length
		this.trackPanel.onAnimationEnded(justPause)

		if (justPause === false) {
			this.segmentedAnimationIndex = undefined
			this.graphsPanel.setTrialLineClip(1)
		}

		// TODO: how to deal with hints and partial motions ?
		if (justPause === false) {
			this.hintDismissed = true
			let bumpDelay = 500
			setTimeout(() => {
				if (this.latestError && this.hintsEnabled) {
					this.graphsPanel.highlightError(this.latestError)
					this.trackPanel.highlightError(this.latestError)

					switch (this.latestError.type) {
						case 's':
							this.currentHint = HINTS['position']
							break
						case 'v':
							this.currentHint = HINTS['velocity']
							break
						case 'a':
							this.currentHint = HINTS['posts']
							break
						default:
							this.currentHint = HINTS['intro']
							break
					}
				}
			}, bumpDelay)

			setTimeout(() => {
				this.hintDismissed = false
			}, bumpDelay + 50)
		}
	}

	clearHints() {
		this.currentHint = undefined
		this.hintDismissed = true
		this.graphsPanel.highlightError()
		this.trackPanel.highlightError()
	}

	debug(type: string) {
		let trialIndex = ''
		if (this.attempts.length) {
			let promptText = `Enter trial index (from 1 to ${this.attempts.length}) or leave empty for goal:`
			trialIndex = prompt('Which trial motion you want to debug?\n\n' + promptText)
		}

		if (trialIndex !== undefined) {
			if (trialIndex === '') {
				printDataTable(this.goalMotion.data, 'goal')
			} else {
				let attempt = this.attempts[+trialIndex - 1]
				printDataTable(attempt.motion.data, `attempt #${trialIndex}`)
			}
		}
	}
}