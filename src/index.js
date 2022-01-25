process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://820487b960be48d98acd84d1ebbbf7bf@errors.cozycloud.cc/24'

const {
  CookieKonnector,
  log,
  solveCaptcha,
  errors
} = require('cozy-konnector-libs')

const VENDOR = 'MyPeopleDoc'
const baseUrl = 'https://www.mypeopledoc.com'

// Needed to read otp code from terminal in standalone or dev mode
const fs = require('fs')

class MyPeopleDocConnector extends CookieKonnector {
  async fetch(fields) {
    log('info', 'Authenticating ...')
    await this.authenticate(fields.login, fields.password)
    log('info', 'Successfully logged in')

    const documents = await this.getDocuments()

    log('info', 'Saving data to Cozy')
    await this.saveFiles(documents, fields, {
      fileIdAttributes: ['vendorRef']
    })
  }

  async authenticate(username, password) {
    if ((await this.testSession()) === true) {
      log('info', 'Already logged')
      return
    }

    await this.deactivateAutoSuccessfulLogin()

    const recaptchaResponse = await solveCaptcha({
      websiteKey: '6LeIGcYbAAAAAEbeaSXsiS5Yk4qTfY7GjdF7wDxA',
      websiteURL: baseUrl
    })

    let res = await this.request
      .post(`${baseUrl}/api/auth/login`, {
        form: {
          captcha: recaptchaResponse,
          username,
          password
        },
        headers: {
          // Required
          'X-VERSION-MPD': 8103
        },
        resolveWithFullResponse: true,
        transform: (body, { statusCode }) => {
          return {
            body,
            statusCode
          }
        }
      })
      .catch(err => {
        log('error', err)
        throw new Error(errors.LOGIN_FAILED)
      })

    res = await this.request(res.body.redirect_url, {
      transform: (body, { request }) => {
        return {
          uri: request.uri.href
        }
      }
    })

    if (res.uri.includes('/login/2fa')) {
      const code = await this.getTwoFaCode()
      const identifier = this.getTwoFaIdentifierFromUri(res.uri)
      log('info', `2FA code : ${code}`)

      await this.request
        .post(`${baseUrl}/api/auth/2fa/${identifier}`, {
          form: {
            code,
            // trusted_device: true change nothing 2fa code is still asked when
            // we need to authenticate
            trusted_device: false
          },
          transform: (body, { statusCode }) => {
            return {
              body,
              statusCode
            }
          }
        })
        .catch(err => {
          log('error', err)
          throw new Error(errors.LOGIN_FAILED)
        })
    }

    await this.saveSession()
    await this.notifySuccessfulLogin()
  }

  async testSession() {
    try {
      await this.request(
        `https://www.mypeopledoc.com/api/documents?deleted=false&order=desc&page=1&per_page=1&sort=valid_at`
      )
      return true
    } catch (err) {
      log('info', `not logged: ${err}`)
      return false
    }
  }

  getTwoFaIdentifierFromUri(url) {
    return url.slice('https://www.mypeopledoc.com/#/login/2fa/'.length)
  }

  // Needed to read otp code from terminal in standalone or dev mode
  readTwoFaCodeFromTerminal() {
    log('info', 'Input otp code and submit by typing Ctrl + D twice')
    return fs.readFileSync(0).toString()
  }

  async getTwoFaCode() {
    if (
      process.env.NODE_ENV === 'standalone' ||
      process.env.NODE_ENV === 'development'
    ) {
      return this.readTwoFaCodeFromTerminal()
    }

    return await this.waitForTwoFaCode({
      type: 'sms'
    })
  }

  // When there is another page, in headers a link attribute is filled with a string containing the url of the next page and 'rel="next"'.
  // When it is the last page there is no rel="next".
  // When there is only one page, link is undefined.
  isThereMoreDocumentsToFetch(link) {
    return link !== undefined && link.includes('rel="next"')
  }

  // Request in a loop to get all documents
  async getDocuments() {
    const hitPerPage = 1000
    let documents = []
    let page = 1

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.request(
        `https://www.mypeopledoc.com/api/documents?deleted=false&order=desc&page=${page}&per_page=${hitPerPage}&sort=valid_at`,
        {
          transform: (body, { statusCode, headers }) => {
            return {
              docs: body,
              statusCode,
              link: headers.link
            }
          }
        }
      ).catch(err => {
        log('error', err)
      })

      res.docs.forEach(doc => {
        documents.push({
          title: doc.title,
          subPath: VENDOR,
          fileurl: `https://www.mypeopledoc.com/api/documents/${doc.id}/download`,
          filename:
            doc.profile && doc.profile.name
              ? `${doc.profile.name}_${doc.name}`
              : doc.name,
          vendorRef: doc.id,
          requestOptions: {
            headers: {
              Accept: '*/*'
            }
          }
        })
      })

      if (!this.isThereMoreDocumentsToFetch(res.link)) break

      ++page
    }

    return documents
  }
}

const connector = new MyPeopleDocConnector({
  debug: false,
  cheerio: false,
  json: true,
  jar: true
})

connector.run()
