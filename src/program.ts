import { EventEmitter } from 'events'
import os from 'os'
import path from 'path'
import TypedEventEmitter from 'typed-emitter'
import { Argv, ParserConfigurationOptions } from 'yargs'
import createYargs from 'yargs/yargs'
import { command, Command } from './command.js'
import { history, History } from './history.js'
import { Repl, repl } from './repl.js'
import { isPromise } from './utils.js'

const DEFAULT_PROMPT = '> '
const DEFAULT_HISTORY_FILE = '.bandersnatch_history'

type Events = {
  run: (command: string | readonly string[]) => void
}

type ProgramOptions = {
  /**
   * Program description. Can also be set by calling
   * `program().description(...)`.
   *
   * Defaults to `undefined`.
   */
  description?: string

  /**
   * Sets a custom REPL prompt. Can also be set by calling
   * `program().prompt(...)`.
   *
   * Defaults to `> `.
   */
  prompt?: string

  /**
   * Whether or not to add a global help command that displays an overview of
   * commands.
   *
   * Defaults to `true`.
   */
  help?: boolean

  /**
   * Whether or not to add a global version command that displays the version as
   * specified in the package.json file.
   *
   * Defaults to `true`.
   */
  version?: boolean

  /**
   * Use this history file. Set to NULL to disable history file.
   *
   * Defaults to `{homedir}/.bandersnatch_history`.
   */
  historyFile?: string | null

  /**
   * Specifies whether to add a default behaviour for an `exit` command.
   *
   * Takes a boolean or a function argument:
   * - `false` installs no handler
   * - `true` will install the default handler
   * - a given function will be installed as the handler
   *
   * Defaults to `() => process.exit()`.
   */
  exit?: boolean | (() => void)

  /**
   * Pass Yargs parser configuration, for available options, see
   * https://github.com/yargs/yargs/blob/main/docs/advanced.md#customizing-yargs-parser.
   *
   * Defaults to `undefined`.
   */
  parserConfiguration?: Partial<ParserConfigurationOptions>
}

/**
 * Creates a new bandersnatch program.
 */
export function program(options: ProgramOptions = {}) {
  return new Program(options)
}

function extractCommandFromProcess() {
  return process.argv.slice(2)
}

export class Program extends (EventEmitter as new () => TypedEventEmitter<Events>) {
  private commands: Command<any>[] = []
  private history?: History
  private replInstance?: Repl

  constructor(public options: ProgramOptions = {}) {
    super()

    // Set default prompt
    if (typeof this.options.prompt === 'undefined') {
      this.options.prompt = DEFAULT_PROMPT
    }

    // Set default historyFile
    if (typeof this.options.historyFile === 'undefined') {
      this.options.historyFile = path.join(os.homedir(), DEFAULT_HISTORY_FILE)
    }

    // Set default exit handler
    if (
      this.options.exit === true ||
      typeof this.options.exit === 'undefined'
    ) {
      this.options.exit = () => process.exit()
    }

    if (this.options.historyFile !== null) {
      this.history = history(this)
    }
  }

  /**
   * Set the program description.
   */
  public description(description: string) {
    this.options.description = description
    return this
  }

  /**
   * Sets a custom REPL prompt.
   */
  public prompt(prompt: string) {
    this.options.prompt = prompt
    return this
  }

  /**
   * Create a new yargs instance. This method may change at any time, not
   * intended for public use.
   *
   * @private
   */
  public createYargsInstance(
    overrideParserConfiguration?: Partial<ParserConfigurationOptions>
  ) {
    let yargs = createYargs()

    this.options.description && yargs.usage(this.options.description)

    // Help accepts boolean
    yargs.help(this.options.help !== false)

    // Version must be false or undefined
    this.options.version !== false ? yargs.version() : yargs.version(false)

    // Pass yargs parser options if defined
    if (typeof this.options.parserConfiguration !== 'undefined') {
      yargs = yargs.parserConfiguration({
        ...this.options.parserConfiguration,
        ...overrideParserConfiguration,
      })
    }

    // Non-configurable options
    yargs.recommendCommands()
    yargs.strict()
    yargs.demandCommand()

    // Hidden completion command
    yargs.completion('completion', false)

    // Custom fail function.
    yargs.fail(this.failHandler.bind(this))

    // In case we're in a REPL session, do not exit on errors.
    yargs.exitProcess(!this.isRepl())

    // Add commands
    this.commands.forEach((command) => {
      command.toYargs(yargs, (command: string) => {
        return this.run(command)
      })
    })

    return yargs
  }

  /**
   * Adds a new command to the program.
   */
  public add<T>(command: Command<T>) {
    this.commands.push(command)
    return this
  }

  /**
   * Adds a new command to the program and marks it as the default command.
   */
  public default<T>(command: Command<T>) {
    this.commands.push(command.default())
    return this
  }

  /**
   * Evaluate command (or process.argv) and return promise.
   */
  public run(command?: string | readonly string[]) {
    const cmd = command || extractCommandFromProcess()

    this.emit('run', cmd)

    // Return promise resolving to the return value of the command
    // handler.
    return new Promise((resolve, reject) => {
      // @ts-ignore Not sure why this is needed?
      this.createYargsInstance()
        .parse(cmd, {}, (err, argv, output) => {
          // We don't use yargs 17 promise style argv
          if (isPromise(argv)) {
            throw new Error('argv is of unexpected type')
          }

          /**
           * From the yargs docs:
           * > any text that would have been output by yargs to the terminal,
           * > had a callback not been provided.
           * http://yargs.js.org/docs/#api-parseargs-context-parsecallback
           *
           * Seems that this is primarily used for built-in commands like
           * --version and --help.
           */
          if (output) {
            console.log(output)
          }

          /**
           * From the yargs docs:
           * > Populated if any validation errors raised while parsing.
           * http://yargs.js.org/docs/#api-parseargs-context-parsecallback
           * This seems to be incorrect though, and err is populated when any
           * error is thrown inside the command handler.
           */
          if (err) {
            // Ignore err value, which encourages users to deliberately handle
            // error conditions in their programs.
          }

          if (isPromise(argv.__promise)) {
            // Delegate resolve/reject to promise returned from handler
            argv.__promise.then(resolve).catch(reject)
          } else {
            // Resolve with undefined if promise is not available, which is the
            // case with e.g. --version and --help. It should be noted that
            // this might need to be filtered when e.g. printing resolved values
            // from command handlers in a .then() function.
            resolve(undefined)
          }
        })
        .catch(() => {})
    })
  }

  /**
   * Run event loop which reads command from stdin.
   */
  public repl() {
    this.replInstance = repl(this)

    // Add exit command
    if (typeof this.options.exit === 'function') {
      this.add(
        command('exit')
          .description('Exit the application')
          .action(this.options.exit)
      )
    }

    if (this.history) {
      this.replInstance.attachHistory(this.history)
    }
    this.replInstance.start()

    return this.replInstance
  }

  /**
   * When argv is set, run the program, otherwise start repl loop.
   */
  public runOrRepl() {
    return extractCommandFromProcess().length ? this.run() : this.repl()
  }

  /**
   * Returns `true` if program is running a repl loop, `false` otherwise.
   */
  public isRepl() {
    return !!this.replInstance
  }

  /**
   * Method to execute when a failure occurs, rather than printing the failure
   * message.
   *
   * Called with the failure message that would have been printed, the Error
   * instance originally thrown and yargs state when the failure occured.
   */
  private failHandler(msg: string, err: Error, yargs: Argv) {
    if (msg) {
      // Simply throw validation messages to reject runner promise
      throw new Error(msg)
    }
  }
}
